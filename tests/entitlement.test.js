import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { addMonths } from '../src/utils/subscriptionPeriod.js'
import {
    PASSWORD, auth, createCategory, createCourse, createInstructor, createStudent, daysAgo, enroll, midtransOk,
    mockFetch, models, mongoUri, notification, pay, resetDb, sign, startTestEnv, stopTestEnv,
} from './helpers.js'

let request

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(resetDb)

const me = async (user) => (await request.get('/api/me').set(auth(user))).body.data
const webhook = (body) => request.post('/api/handle-payment-midtrans').send(body)
const settle = (transaction, overrides) => webhook(notification(transaction, overrides))
const iso = (value) => new Date(value).toISOString()

const withProvider = async (handler, fn) => {
    const mock = mockFetch(handler)

    try {
        return await fn(mock)
    } finally {
        mock.restore()
    }
}

// Starts a checkout through the API (provider mocked) and returns the pending transaction it created.
const startCheckoutFor = async (instructor) => {
    await withProvider(midtransOk('https://pay.test/p'), async () => {
        const res = await request.post('/api/payment/checkout').set(auth(instructor))

        assert.equal(res.status, 200)
    })

    return models.transactionModel.findOne({ user: instructor._id, status: 'pending' }).sort({ createdAt: -1 })
}

// One instructor per access state
const states = {
    NONE: (i) => i,
    PENDING: (i) => pay(i, { status: 'pending' }),
    FAILED: (i) => pay(i, { status: 'failed' }),
    EXPIRED: (i) => pay(i, { paidAt: daysAgo(45) }),
    ACTIVE: (i) => pay(i),
}

const instructorIn = async (state) => {
    const instructor = await createInstructor({ active: false })

    await states[state](instructor)

    return instructor
}

describe('access state resolution (via /api/me)', () => {
    for (const state of Object.keys(states)) {
        it(`reports ${state}`, async () => {
            const instructor = await instructorIn(state)

            assert.equal((await me(instructor)).accessStatus, state)
        })
    }

    it('turns ACTIVE into EXPIRED purely by time, with no scheduled job', async () => {
        const stillRunning = await createInstructor({ active: false })
        const justEnded = await createInstructor({ active: false })
        // one hour before / one hour after the end of a one-month period
        await pay(stillRunning, { paidAt: new Date(addMonths(new Date(), -1).getTime() + 3600e3) })
        await pay(justEnded, { paidAt: new Date(addMonths(new Date(), -1).getTime() - 3600e3) })

        assert.equal((await me(stillRunning)).accessStatus, 'ACTIVE')
        assert.equal((await me(justEnded)).accessStatus, 'EXPIRED')
        assert.equal(
            await models.transactionModel.countDocuments({ status: 'success' }),
            2,
            'nothing is rewritten when access ends'
        )
    })

    it('keeps the period dates visible once expired', async () => {
        const instructor = await createInstructor({ active: false })
        const paidAt = daysAgo(45)
        await pay(instructor, { paidAt })

        const data = await me(instructor)

        assert.equal(data.accessStatus, 'EXPIRED')
        assert.equal(iso(data.accessStartsAt), iso(paidAt))
        assert.equal(iso(data.accessExpiresAt), iso(addMonths(paidAt, 1)))
    })
})

describe('first payment', () => {
    it('a valid webhook activates once and grants a bounded calendar-month period', async () => {
        const instructor = await createInstructor({ active: false })
        const pending = await startCheckoutFor(instructor)
        assert.equal(pending.purpose, 'activation')
        assert.equal(pending.periodMonths, 1)
        assert.equal(pending.paidAt, undefined)
        assert.equal((await me(instructor)).accessStatus, 'PENDING')

        const before = Date.now()
        assert.equal((await settle(pending)).status, 200)

        const paid = await models.transactionModel.findById(pending._id)
        assert.equal(paid.status, 'success')
        assert.ok(paid.paidAt.getTime() >= before - 1000 && paid.paidAt.getTime() <= Date.now())

        const data = await me(instructor)
        assert.equal(data.accessStatus, 'ACTIVE')
        assert.equal(iso(data.accessStartsAt), iso(paid.paidAt))
        assert.equal(iso(data.accessExpiresAt), iso(addMonths(paid.paidAt, 1)))
    })

    it('uses SUBSCRIPTION_PERIOD_MONTHS for new orders only', async () => {
        const instructor = await createInstructor({ active: false })
        process.env.SUBSCRIPTION_PERIOD_MONTHS = '3'

        try {
            const pending = await startCheckoutFor(instructor)
            assert.equal(pending.periodMonths, 3)

            process.env.SUBSCRIPTION_PERIOD_MONTHS = '1' // changing config must not change this order
            await settle(pending)

            const paid = await models.transactionModel.findById(pending._id)
            assert.equal(iso((await me(instructor)).accessExpiresAt), iso(addMonths(paid.paidAt, 3)))
        } finally {
            delete process.env.SUBSCRIPTION_PERIOD_MONTHS
        }
    })
})

describe('renewal', () => {
    it('early renewal extends from the current expiry and never shortens the period', async () => {
        const instructor = await createInstructor({ active: false })
        const firstPaidAt = daysAgo(10)
        await pay(instructor, { paidAt: firstPaidAt })
        const before = await me(instructor)

        const pending = await startCheckoutFor(instructor)
        assert.equal(pending.purpose, 'renewal')
        assert.equal(iso((await me(instructor)).accessExpiresAt), iso(before.accessExpiresAt), 'unchanged until paid')

        await settle(pending)

        const after = await me(instructor)
        assert.equal(after.accessStatus, 'ACTIVE')
        assert.equal(iso(after.accessStartsAt), iso(firstPaidAt), 'the run keeps its start')
        assert.equal(iso(after.accessExpiresAt), iso(addMonths(before.accessExpiresAt, 1)), 'extended from the old expiry')
        assert.ok(new Date(after.accessExpiresAt) > new Date(before.accessExpiresAt))
    })

    it('renewal after expiry starts at the payment time', async () => {
        const instructor = await createInstructor({ active: false })
        await pay(instructor, { paidAt: daysAgo(45) })
        assert.equal((await me(instructor)).accessStatus, 'EXPIRED')

        const pending = await startCheckoutFor(instructor)
        assert.equal(pending.purpose, 'renewal', 'an expired instructor who paid before is renewing')
        await settle(pending)

        const paid = await models.transactionModel.findById(pending._id)
        const data = await me(instructor)

        assert.equal(data.accessStatus, 'ACTIVE')
        assert.equal(iso(data.accessStartsAt), iso(paid.paidAt))
        assert.equal(iso(data.accessExpiresAt), iso(addMonths(paid.paidAt, 1)))
    })

    it('a failed renewal does not touch still-valid access', async () => {
        const instructor = await createInstructor({ active: false })
        await pay(instructor, { paidAt: daysAgo(10) })
        const before = await me(instructor)

        const pending = await startCheckoutFor(instructor)
        await settle(pending, { transaction_status: 'expire' })

        const after = await me(instructor)
        assert.equal(after.accessStatus, 'ACTIVE')
        assert.equal(iso(after.accessExpiresAt), iso(before.accessExpiresAt))
        assert.equal((await models.transactionModel.findById(pending._id)).status, 'failed')
        assert.equal((await request.get('/api/courses').set(auth(instructor))).status, 200)
    })

    it('a pending renewal does not touch still-valid access', async () => {
        const instructor = await createInstructor({ active: false })
        await pay(instructor, { paidAt: daysAgo(10) })
        const before = await me(instructor)

        await startCheckoutFor(instructor)

        const after = await me(instructor)
        assert.equal(after.accessStatus, 'ACTIVE')
        assert.equal(iso(after.accessExpiresAt), iso(before.accessExpiresAt))
    })

    it('a failed renewal after expiry is FAILED, and recovery by payment works', async () => {
        const instructor = await createInstructor({ active: false })
        await pay(instructor, { paidAt: daysAgo(45) })

        const failed = await startCheckoutFor(instructor)
        await settle(failed, { transaction_status: 'deny' })
        assert.equal((await me(instructor)).accessStatus, 'FAILED')

        const retry = await startCheckoutFor(instructor)
        assert.notEqual(String(retry._id), String(failed._id))
        await settle(retry)
        assert.equal((await me(instructor)).accessStatus, 'ACTIVE')
    })

    it('stacked early renewals each add one period', async () => {
        const instructor = await createInstructor({ active: false })
        const first = daysAgo(5)
        await pay(instructor, { paidAt: first })
        await pay(instructor, { paidAt: daysAgo(4) })
        await pay(instructor, { paidAt: daysAgo(3) })

        assert.equal(iso((await me(instructor)).accessExpiresAt), iso(addMonths(first, 3)))
    })
})

describe('idempotency', () => {
    it('a replayed successful webhook grants nothing more and changes nothing', async () => {
        const instructor = await createInstructor({ active: false })
        const pending = await startCheckoutFor(instructor)

        await settle(pending)
        const paid = await models.transactionModel.findById(pending._id)
        const first = await me(instructor)

        for (let i = 0; i < 3; i += 1) assert.equal((await settle(pending)).status, 200)

        const replayed = await models.transactionModel.findById(pending._id)
        assert.equal(iso(replayed.paidAt), iso(paid.paidAt), 'paidAt is never reset')
        assert.deepEqual(await me(instructor), first)
        assert.equal(await models.transactionModel.countDocuments({ user: instructor._id, status: 'success' }), 1)
    })

    it('concurrent duplicate deliveries grant exactly one period', async () => {
        const instructor = await createInstructor({ active: false })
        const pending = await startCheckoutFor(instructor)

        const results = await Promise.all(Array.from({ length: 6 }, () => settle(pending)))

        assert.ok(results.every((res) => res.status === 200))

        const paid = await models.transactionModel.findById(pending._id)
        const data = await me(instructor)
        assert.equal(iso(data.accessExpiresAt), iso(addMonths(paid.paidAt, 1)))
    })

    it('replaying an old payment after a later renewal does not alter the applied renewal', async () => {
        const instructor = await createInstructor({ active: false })
        const a = await startCheckoutFor(instructor)
        await settle(a)

        // reuse window would hand back the same page, so create the second order explicitly
        const b = await pay(instructor, { status: 'pending', purpose: 'renewal' })
        await settle(b)

        const before = await me(instructor)
        await settle(a)
        await settle(b)

        assert.deepEqual(await me(instructor), before)
    })

    it('a late success cannot resurrect a failed payment or upgrade it into access', async () => {
        const instructor = await createInstructor({ active: false })
        const pending = await startCheckoutFor(instructor)

        await settle(pending, { transaction_status: 'expire' })
        await settle(pending)

        assert.equal((await models.transactionModel.findById(pending._id)).status, 'failed')
        assert.equal((await me(instructor)).accessStatus, 'FAILED')
    })
})

describe('forged or invalid notifications never change entitlement', () => {
    it('an unsigned or wrongly signed webhook leaves the entitlement untouched', async () => {
        const instructor = await createInstructor({ active: false })
        await pay(instructor, { paidAt: daysAgo(45) })
        const pending = await startCheckoutFor(instructor)
        const before = await me(instructor)

        const unsigned = {
            order_id: pending._id.toString(), status_code: '200', gross_amount: `${pending.price}.00`, transaction_status: 'settlement',
        }

        assert.equal((await webhook(unsigned)).status, 403)
        assert.equal((await webhook(sign(unsigned, 'wrong-key'))).status, 403)

        assert.deepEqual(await me(instructor), before)
        assert.equal(before.accessStatus, 'PENDING')
        assert.equal((await models.transactionModel.findById(pending._id)).paidAt, undefined)
    })

    it('a correctly signed webhook with the wrong amount never grants access', async () => {
        const instructor = await createInstructor({ active: false })
        const pending = await startCheckoutFor(instructor)

        const res = await settle(pending, { gross_amount: '1000.00' })

        assert.equal(res.status, 400)
        assert.equal((await me(instructor)).accessStatus, 'PENDING')
        assert.equal((await models.transactionModel.findById(pending._id)).status, 'pending')
    })

    it('a challenged card capture does not grant access', async () => {
        const instructor = await createInstructor({ active: false })
        const pending = await startCheckoutFor(instructor)

        await settle(pending, { transaction_status: 'capture', fraud_status: 'challenge' })

        assert.equal((await me(instructor)).accessStatus, 'PENDING')
    })
})

describe('instructor hard entitlement', () => {
    const management = (instructor, course, student) => [
        ['GET', '/api/courses'],
        ['GET', '/api/students'],
        ['GET', '/api/overviews'],
        ['GET', `/api/courses/${course._id}`],
        ['GET', `/api/courses/students/${course._id}`],
        ['GET', `/api/students/${student._id}`],
        ['POST', `/api/courses/students/${course._id}`, { studentId: student._id }],
        ['POST', `/api/courses/${course._id}/sections`, { title: 'A new section' }],
    ]

    for (const state of ['NONE', 'PENDING', 'FAILED', 'EXPIRED']) {
        it(`blocks every management endpoint when ${state} with 403 ACCESS_NOT_ACTIVE`, async () => {
            const instructor = await createInstructor({ active: true })
            const course = await createCourse(instructor, await createCategory())
            const student = await createStudent(instructor)
            await models.transactionModel.deleteMany({ user: instructor._id })
            await states[state](instructor)

            for (const [method, url, body] of management(instructor, course, student)) {
                let req = request[method.toLowerCase()](url).set(auth(instructor))
                if (body) req = req.send(body)
                const res = await req

                assert.equal(res.status, 403, `${method} ${url}`)
                assert.equal(res.body.code, 'ACCESS_NOT_ACTIVE')
                assert.equal(res.body.accessStatus, state)
            }

            assert.equal((await models.courseModel.findById(course._id)).students.length, 0, 'nothing was changed')
        })
    }

    it('allows the same endpoints when ACTIVE', async () => {
        const instructor = await createInstructor({ active: true })
        const course = await createCourse(instructor, await createCategory())
        const student = await createStudent(instructor)

        for (const [method, url, body] of management(instructor, course, student).slice(0, 7)) {
            let req = request[method.toLowerCase()](url).set(auth(instructor))
            if (body) req = req.send(body)

            assert.equal((await req).status, 200, `${method} ${url}`)
        }
    })

    for (const state of ['NONE', 'PENDING', 'FAILED', 'EXPIRED']) {
        it(`keeps identity and payment recovery reachable when ${state}`, async () => {
            const instructor = await instructorIn(state)

            assert.equal((await request.get('/api/health')).status, 200)
            assert.equal((await request.post('/api/sign-in').send({ email: instructor.email, password: PASSWORD })).status, 200)
            assert.equal((await request.get('/api/me').set(auth(instructor))).status, 200)
            assert.equal((await request.get('/api/categories').set(auth(instructor))).status, 200)

            await withProvider(midtransOk(), async () => {
                assert.equal((await request.post('/api/payment/checkout').set(auth(instructor))).status, 200)
            })
        })
    }

    it('an expired instructor regains access by paying, with no other step', async () => {
        const instructor = await instructorIn('EXPIRED')
        assert.equal((await request.get('/api/courses').set(auth(instructor))).status, 403)

        await settle(await startCheckoutFor(instructor))

        assert.equal((await request.get('/api/courses').set(auth(instructor))).status, 200)
    })
})

describe('student hard entitlement (inherited from the instructor)', () => {
    const learn = async (state) => {
        const instructor = await instructorIn(state)
        const student = await createStudent(instructor)
        const course = await createCourse(instructor, await createCategory(), { published: true })
        await enroll(course, student)

        return { instructor, student, course }
    }

    it('allows learning when the instructor workspace is ACTIVE', async () => {
        const { student, course } = await learn('ACTIVE')

        assert.equal((await request.get('/api/students-courses').set(auth(student))).status, 200)
        assert.equal((await request.get(`/api/students-courses/${course._id}`).set(auth(student))).status, 200)
    })

    for (const state of ['NONE', 'PENDING', 'FAILED', 'EXPIRED']) {
        it(`blocks learning when the instructor workspace is ${state}`, async () => {
            const { student, course } = await learn(state)

            for (const url of ['/api/students-courses', `/api/students-courses/${course._id}`]) {
                const res = await request.get(url).set(auth(student))

                assert.equal(res.status, 403, url)
                assert.equal(res.body.code, 'WORKSPACE_ACCESS_INACTIVE')
                assert.equal(res.body.accessStatus, state)
            }
        })

        it(`still lets a student sign in and see the workspace state when ${state}`, async () => {
            const { student } = await learn(state)

            const login = await request.post('/api/sign-in').send({ email: student.email, password: PASSWORD })
            const profile = await me(student)

            assert.equal(login.status, 200)
            assert.ok(login.body.data.token)
            assert.equal(login.body.data.accessStatus, state)
            assert.equal(profile.accessStatus, state)
        })
    }

    it('follows the instructor over time: renewing the workspace re-opens learning for the student', async () => {
        const { instructor, student } = await learn('EXPIRED')
        assert.equal((await request.get('/api/students-courses').set(auth(student))).status, 403)

        await settle(await startCheckoutFor(instructor))

        assert.equal((await request.get('/api/students-courses').set(auth(student))).status, 200)
    })

    it('does not copy entitlement onto the student record', async () => {
        const { student } = await learn('ACTIVE')

        const stored = (await models.userModel.findById(student._id)).toObject()

        assert.equal('accessStatus' in stored, false)
        assert.equal('accessExpiresAt' in stored, false)
    })

    it('a student cannot create or renew workspace payments', async () => {
        const { student } = await learn('ACTIVE')
        const before = await models.transactionModel.countDocuments()

        assert.equal((await request.post('/api/payment/checkout').set(auth(student))).status, 403)
        assert.equal(await models.transactionModel.countDocuments(), before)
    })

    it('keeps instructor-only endpoints closed to students even when ACTIVE', async () => {
        const { student } = await learn('ACTIVE')

        assert.equal((await request.get('/api/courses').set(auth(student))).status, 403)
    })
})

describe('student without a valid instructor relationship fails closed', () => {
    const orphan = (extra = {}) =>
        models.userModel.create({
            name: 'Orphan Student',
            email: `orphan${Math.random().toString(36).slice(2)}@test.dev`,
            password: 'x',
            photo: 'default.png',
            role: 'student',
            ...extra,
        })

    const assertClosed = async (student) => {
        const res = await request.get('/api/students-courses').set(auth(student))

        assert.equal(res.status, 403)
        assert.equal(res.body.code, 'WORKSPACE_ACCESS_INACTIVE')
        assert.equal(res.body.accessStatus, 'NONE')
        assert.equal((await me(student)).accessStatus, 'NONE')
    }

    it('no instructor at all', async () => {
        await assertClosed(await orphan())
    })

    it('instructor record was deleted', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)
        await models.userModel.deleteOne({ _id: instructor._id })

        await assertClosed(student)
    })

    it('the stored "manager" is not an instructor', async () => {
        const instructor = await createInstructor()
        const otherStudent = await createStudent(instructor)

        await assertClosed(await orphan({ manager: otherStudent._id }))
    })
})

describe('/api/me and sign-in contract', () => {
    it('instructor: identity, role and entitlement dates', async () => {
        const instructor = await createInstructor({ active: false })
        const paidAt = daysAgo(3)
        await pay(instructor, { paidAt })

        const data = await me(instructor)

        assert.deepEqual(Object.keys(data).sort(), ['accessExpiresAt', 'accessStartsAt', 'accessStatus', 'email', 'name', 'role'])
        assert.equal(data.role, 'manager')
        assert.equal(data.accessStatus, 'ACTIVE')
        assert.equal(iso(data.accessStartsAt), iso(paidAt))
        assert.equal(iso(data.accessExpiresAt), iso(addMonths(paidAt, 1)))
    })

    it('student: identity plus the instructor workspace entitlement, no transaction details', async () => {
        const instructor = await createInstructor({ active: false })
        const paidAt = daysAgo(3)
        await pay(instructor, { paidAt })
        const student = await createStudent(instructor)

        const data = await me(student)

        assert.equal(data.role, 'student')
        assert.equal(data.accessStatus, 'ACTIVE')
        assert.equal(iso(data.accessExpiresAt), iso(addMonths(paidAt, 1)))
        assert.equal(JSON.stringify(data).includes('price'), false)
        assert.equal(JSON.stringify(data).includes('paymentUrl'), false)
    })

    it('sign-in returns the same entitlement fields as /api/me', async () => {
        const instructor = await createInstructor({ active: false })
        await pay(instructor, { paidAt: daysAgo(45) })

        const login = await request.post('/api/sign-in').send({ email: instructor.email, password: PASSWORD })

        assert.equal(login.status, 200)
        assert.equal(login.body.data.accessStatus, 'EXPIRED')
        assert.equal(iso(login.body.data.accessExpiresAt), iso((await me(instructor)).accessExpiresAt))
        assert.ok(login.body.data.accessStartsAt)
    })
})

describe('checkout contract', () => {
    it('activation: first payment of a new instructor', async () => {
        const instructor = await createInstructor({ active: false })

        await withProvider(midtransOk('https://pay.test/a'), async () => {
            const res = await request.post('/api/payment/checkout').set(auth(instructor))

            assert.equal(res.body.data.purpose, 'activation')
            assert.equal(res.body.data.reused, false)
            assert.equal(res.body.data.accessStatus, 'NONE')
            assert.equal(res.body.data.midtrans_payment_url, 'https://pay.test/a')
            assert.equal(JSON.stringify(res.body).toLowerCase().includes('server'), false, 'no provider secrets')
        })
    })

    it('renewal while ACTIVE reports the current expiry and reuses a recent pending page', async () => {
        const instructor = await createInstructor({ active: false })
        await pay(instructor, { paidAt: daysAgo(2) })

        await withProvider(midtransOk('https://pay.test/r'), async (mock) => {
            const first = await request.post('/api/payment/checkout').set(auth(instructor))
            const second = await request.post('/api/payment/checkout').set(auth(instructor))

            assert.equal(first.body.data.purpose, 'renewal')
            assert.equal(first.body.data.accessStatus, 'ACTIVE')
            assert.ok(first.body.data.accessExpiresAt)
            assert.equal(first.body.data.reused, false)
            assert.equal(second.body.data.reused, true)
            assert.equal(second.body.data.midtrans_payment_url, 'https://pay.test/r')
            assert.equal(mock.calls.length, 1)
        })
    })

    it('a failed provider call during an active renewal leaves nothing behind and access intact', async () => {
        const instructor = await createInstructor({ active: false })
        await pay(instructor, { paidAt: daysAgo(2) })

        await withProvider(
            () => new Response('{}', { status: 500 }),
            async () => {
                const res = await request.post('/api/payment/checkout').set(auth(instructor))

                assert.equal(res.status, 502)
            }
        )

        assert.equal(await models.transactionModel.countDocuments({ user: instructor._id }), 1)
        assert.equal((await me(instructor)).accessStatus, 'ACTIVE')
    })

    it('sign-up creates an activation order that carries the configured period', async () => {
        await withProvider(midtransOk('https://pay.test/s'), async () => {
            const res = await request
                .post('/api/sign-up')
                .send({ name: 'Company Owner', email: 'owner@company.dev', password: 'secret-pass-1' })

            assert.equal(res.status, 200)
        })

        const tx = await models.transactionModel.findOne()
        assert.equal(tx.purpose, 'activation')
        assert.equal(tx.periodMonths, 1)
        assert.equal(tx.paidAt, undefined)
    })
})

describe('legacy data compatibility', () => {
    const legacy = (instructor, updatedAt) =>
        models.transactionModel.collection.insertOne({
            user: instructor._id,
            price: 280000,
            status: 'success',
            createdAt: updatedAt,
            updatedAt,
        })

    it('a recent legacy payment (no paidAt) grants one period from its last write', async () => {
        const instructor = await createInstructor({ active: false })
        const updatedAt = daysAgo(5)
        await legacy(instructor, updatedAt)

        const data = await me(instructor)

        assert.equal(data.accessStatus, 'ACTIVE')
        assert.equal(iso(data.accessExpiresAt), iso(addMonths(updatedAt, 1)))
    })

    it('an old legacy payment does not keep permanent access', async () => {
        const instructor = await createInstructor({ active: false })
        await legacy(instructor, daysAgo(90))

        assert.equal((await me(instructor)).accessStatus, 'EXPIRED')
        assert.equal((await request.get('/api/courses').set(auth(instructor))).status, 403)
    })

    it('the backfill script reports first, writes only on request, and is idempotent', async () => {
        const instructor = await createInstructor({ active: false })
        const updatedAt = daysAgo(5)
        await legacy(instructor, updatedAt)
        const root = path.resolve(import.meta.dirname, '..')
        const run = (...args) =>
            execFileSync(process.execPath, ['scripts/backfill-paid-at.js', ...args], {
                cwd: root,
                env: { ...process.env, DATABASE_URL: mongoUri() },
                encoding: 'utf8',
            })
        const stored = () => models.transactionModel.collection.findOne({ user: instructor._id })

        const dry = run('--dry-run')
        assert.match(dry, /1 legacy successful transaction/)
        assert.equal((await stored()).paidAt, undefined, 'dry run writes nothing')

        const first = run()
        assert.match(first, /Updated 1 transaction/)
        assert.equal(iso((await stored()).paidAt), iso(updatedAt))
        assert.equal((await stored()).periodMonths, 1)

        const second = run()
        assert.match(second, /0 legacy successful transaction/)
        assert.equal(await models.transactionModel.countDocuments({ user: instructor._id }), 1, 'no history invented')
        assert.equal(iso((await me(instructor)).accessExpiresAt), iso(addMonths(updatedAt, 1)), 'entitlement unchanged')
    })
})
