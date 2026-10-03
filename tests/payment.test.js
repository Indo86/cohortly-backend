import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    PASSWORD, SERVER_KEY, auth, createCategory, createInstructor, createStudent, midtransOk, mockFetch, models,
    notification, resetDb, sign, startTestEnv, stopTestEnv,
} from './helpers.js'

let request

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(resetDb)

const signUp = (overrides = {}) =>
    request.post('/api/sign-up').send({
        name: 'Company Owner',
        email: 'owner@company.dev',
        password: 'secret-pass-1',
        ...overrides,
    })

const withProvider = async (handler, fn) => {
    const mock = mockFetch(handler)

    try {
        return await fn(mock)
    } finally {
        mock.restore()
    }
}

const pendingInstructor = async () => {
    const instructor = await createInstructor({ active: false })
    const transaction = await models.transactionModel.create({ user: instructor._id, price: 280000 })

    return { instructor, transaction }
}

describe('sign-up and the Midtrans call', () => {
    it('creates an instructor with a pending payment and returns the payment url', async () => {
        await withProvider(midtransOk('https://pay.test/abc'), async (mock) => {
            const res = await signUp()

            assert.equal(res.status, 200)
            assert.equal(res.body.message, 'Sign Up Success')
            assert.equal(res.body.data.midtrans_payment_url, 'https://pay.test/abc')

            const user = await models.userModel.findOne({ email: 'owner@company.dev' })
            assert.equal(user.role, 'manager')
            assert.equal(user.photo, 'default.png')

            const [transaction] = await models.transactionModel.find({ user: user._id })
            assert.equal(transaction.status, 'pending')
            assert.equal(transaction.price, 280000)
            assert.equal(transaction.paymentUrl, 'https://pay.test/abc')

            // what we sent to the (mocked) provider
            const [call] = mock.calls
            assert.equal(call.url, process.env.MIDTRANS_URL)
            assert.equal(call.body.transaction_details.order_id, transaction._id.toString())
            assert.equal(call.body.transaction_details.gross_amount, 280000)
            assert.equal(call.body.callbacks.finish, 'http://app.test/success-checkout')
            assert.equal(call.options.headers.Authorization, `Basic ${process.env.MIDTRANS_AUTH_STRING}`)
        })
    })

    it('rolls everything back and answers 502 when the provider is unreachable', async () => {
        await withProvider(
            () => {
                throw new Error('network down')
            },
            async () => {
                const res = await signUp()

                assert.equal(res.status, 502)
                assert.equal(await models.userModel.countDocuments(), 0)
                assert.equal(await models.transactionModel.countDocuments(), 0)

                // the same email can simply be retried afterwards
                await withProvider(midtransOk(), async () => {
                    assert.equal((await signUp()).status, 200)
                })
            }
        )
    })

    it('does not report success when the provider returns no payment url', async () => {
        await withProvider(
            () => new Response(JSON.stringify({ token: 'only-token' }), { status: 201 }),
            async () => {
                const res = await signUp()

                assert.equal(res.status, 502)
                assert.equal(await models.userModel.countDocuments(), 0)
                assert.equal(await models.transactionModel.countDocuments(), 0)
            }
        )
    })

    it('does not report success when the provider rejects the request', async () => {
        await withProvider(
            () => new Response(JSON.stringify({ error_messages: ['bad key'] }), { status: 401 }),
            async () => {
                const res = await signUp()

                assert.equal(res.status, 502)
                assert.equal(JSON.stringify(res.body).includes('bad key'), false, 'provider details are not leaked')
                assert.equal(await models.userModel.countDocuments(), 0)
            }
        )
    })

    it('fails closed with 503 when Midtrans is not configured', async () => {
        const saved = process.env.MIDTRANS_URL
        process.env.MIDTRANS_URL = ''

        try {
            const res = await signUp()

            assert.equal(res.status, 503)
            assert.equal(await models.userModel.countDocuments(), 0)
        } finally {
            process.env.MIDTRANS_URL = saved
        }
    })

    it('validates the sign-up body with 400', async () => {
        const res = await signUp({ email: 'bad-email', password: '1' })

        assert.equal(res.status, 400)
        assert.ok(res.body.errors.length >= 2)
    })
})

describe('authentication is separate from payment/access state', () => {
    it('lets an instructor with a PENDING payment sign in and reports the access state', async () => {
        const { instructor } = await pendingInstructor()

        const res = await request.post('/api/sign-in').send({ email: instructor.email, password: PASSWORD })

        assert.equal(res.status, 200)
        assert.equal(res.body.data.accessStatus, 'PENDING')
        assert.ok(res.body.data.token)
    })

    it('reports NONE for an instructor without any transaction and FAILED after a failed payment', async () => {
        const instructor = await createInstructor({ active: false })

        let res = await request.post('/api/sign-in').send({ email: instructor.email, password: PASSWORD })
        assert.equal(res.body.data.accessStatus, 'NONE')

        await models.transactionModel.create({ user: instructor._id, price: 280000, status: 'failed' })

        res = await request.post('/api/sign-in').send({ email: instructor.email, password: PASSWORD })
        assert.equal(res.body.data.accessStatus, 'FAILED')
    })

    it('blocks paid instructor functionality with 403 ACCESS_NOT_ACTIVE (not 400/401)', async () => {
        const { instructor } = await pendingInstructor()

        for (const url of ['/api/courses', '/api/students', '/api/overviews']) {
            const res = await request.get(url).set(auth(instructor))

            assert.equal(res.status, 403, url)
            assert.equal(res.body.code, 'ACCESS_NOT_ACTIVE')
            assert.equal(res.body.accessStatus, 'PENDING')
        }
    })

    it('still lets a pending instructor read their identity and categories', async () => {
        const { instructor } = await pendingInstructor()
        await createCategory()

        assert.equal((await request.get('/api/me').set(auth(instructor))).status, 200)
        assert.equal((await request.get('/api/categories').set(auth(instructor))).status, 200)
    })

    it('lets a student of a pending workspace sign in, but blocks learning features (M3A hard entitlement)', async () => {
        const { instructor } = await pendingInstructor()
        const student = await createStudent(instructor)

        const res = await request.post('/api/sign-in').send({ email: student.email, password: PASSWORD })

        assert.equal(res.status, 200)
        assert.equal(res.body.data.accessStatus, 'PENDING')

        const blocked = await request.get('/api/students-courses').set(auth(student))
        assert.equal(blocked.status, 403)
        assert.equal(blocked.body.code, 'WORKSPACE_ACCESS_INACTIVE')
    })
})

describe('Midtrans webhook', () => {
    const post = (body) => request.post('/api/handle-payment-midtrans').send(body)

    it('activates the instructor workspace on a validly signed settlement', async () => {
        const { instructor, transaction } = await pendingInstructor()

        const res = await post(notification(transaction))

        assert.equal(res.status, 200)
        assert.equal((await models.transactionModel.findById(transaction._id)).status, 'success')

        const me = await request.get('/api/me').set(auth(instructor))
        assert.equal(me.body.data.accessStatus, 'ACTIVE')
        assert.equal((await request.get('/api/courses').set(auth(instructor))).status, 200)
    })

    it('accepts a card capture without fraud challenge', async () => {
        const { transaction } = await pendingInstructor()

        await post(notification(transaction, { transaction_status: 'capture', fraud_status: 'accept' }))

        assert.equal((await models.transactionModel.findById(transaction._id)).status, 'success')
    })

    it('keeps a challenged card capture pending', async () => {
        const { transaction } = await pendingInstructor()

        const res = await post(notification(transaction, { transaction_status: 'capture', fraud_status: 'challenge' }))

        assert.equal(res.status, 200)
        assert.equal((await models.transactionModel.findById(transaction._id)).status, 'pending')
    })

    it('rejects an unsigned payload with 403 and changes nothing', async () => {
        const { instructor, transaction } = await pendingInstructor()

        const res = await post({
            order_id: transaction._id.toString(),
            status_code: '200',
            gross_amount: '280000.00',
            transaction_status: 'settlement',
        })

        assert.equal(res.status, 403)
        assert.equal((await models.transactionModel.findById(transaction._id)).status, 'pending')
        assert.equal((await request.get('/api/courses').set(auth(instructor))).status, 403)
    })

    it('rejects a payload signed with the wrong key with 403', async () => {
        const { transaction } = await pendingInstructor()

        const forged = sign(
            { order_id: transaction._id.toString(), status_code: '200', gross_amount: '280000.00', transaction_status: 'settlement' },
            'attacker-guessed-key'
        )

        assert.equal((await post(forged)).status, 403)
        assert.equal((await models.transactionModel.findById(transaction._id)).status, 'pending')
    })

    it('rejects a valid signature that was tampered with afterwards (status/amount swap)', async () => {
        const { transaction } = await pendingInstructor()
        const signed = notification(transaction, { transaction_status: 'expire' })

        const res = await post({ ...signed, transaction_status: 'settlement', gross_amount: '1.00' })

        assert.equal(res.status, 403)
        assert.equal((await models.transactionModel.findById(transaction._id)).status, 'pending')
    })

    it('rejects a correctly signed notification whose amount differs from our record (400)', async () => {
        const { transaction } = await pendingInstructor()

        const res = await post(notification(transaction, { gross_amount: '1000.00' }))

        assert.equal(res.status, 400)
        assert.equal((await models.transactionModel.findById(transaction._id)).status, 'pending')
    })

    it('answers 404 for an unknown or malformed order id', async () => {
        const { transaction } = await pendingInstructor()

        const unknown = await post(notification({ _id: '64b64b64b64b64b64b64b64b', price: 280000 }))
        const malformed = await post(notification({ _id: 'not-an-object-id', price: transaction.price }))

        assert.equal(unknown.status, 404)
        assert.equal(malformed.status, 404)
    })

    it('fails closed (403) when the server key is not configured', async () => {
        const { transaction } = await pendingInstructor()
        const savedAuth = process.env.MIDTRANS_AUTH_STRING
        process.env.MIDTRANS_AUTH_STRING = ''

        try {
            const res = await post(notification(transaction))

            assert.equal(res.status, 403)
            assert.equal((await models.transactionModel.findById(transaction._id)).status, 'pending')
        } finally {
            process.env.MIDTRANS_AUTH_STRING = savedAuth
        }
    })

    it('uses MIDTRANS_SERVER_KEY when explicitly provided', async () => {
        const { transaction } = await pendingInstructor()
        process.env.MIDTRANS_SERVER_KEY = 'explicit-server-key'

        try {
            assert.equal((await post(notification(transaction))).status, 403, 'derived key no longer valid')

            const ok = sign(
                { order_id: transaction._id.toString(), status_code: '200', gross_amount: '280000.00', transaction_status: 'settlement' },
                'explicit-server-key'
            )

            assert.equal((await post(ok)).status, 200)
        } finally {
            delete process.env.MIDTRANS_SERVER_KEY
        }
    })

    it('is idempotent: a replayed settlement leaves a successful payment successful', async () => {
        const { transaction } = await pendingInstructor()

        await post(notification(transaction))
        const replay = await post(notification(transaction))

        assert.equal(replay.status, 200)
        assert.equal((await models.transactionModel.findById(transaction._id)).status, 'success')
    })

    it('never downgrades a successful payment', async () => {
        const { transaction } = await pendingInstructor()

        await post(notification(transaction))
        await post(notification(transaction, { transaction_status: 'expire' }))

        assert.equal((await models.transactionModel.findById(transaction._id)).status, 'success')
    })

    it('never resurrects a failed payment', async () => {
        const { transaction } = await pendingInstructor()

        await post(notification(transaction, { transaction_status: 'expire' }))
        assert.equal((await models.transactionModel.findById(transaction._id)).status, 'failed')

        await post(notification(transaction, { transaction_status: 'settlement' }))
        assert.equal((await models.transactionModel.findById(transaction._id)).status, 'failed')
    })

    it('does not change a pending payment on an intermediate status', async () => {
        const { transaction } = await pendingInstructor()

        const res = await post(notification(transaction, { transaction_status: 'pending' }))

        assert.equal(res.status, 200)
        assert.equal((await models.transactionModel.findById(transaction._id)).status, 'pending')
    })
})

describe('checkout retry', () => {
    it('creates a new payment page for an instructor whose workspace is not active', async () => {
        const instructor = await createInstructor({ active: false })

        await withProvider(midtransOk('https://pay.test/retry'), async () => {
            const res = await request.post('/api/payment/checkout').set(auth(instructor))

            assert.equal(res.status, 200)
            assert.equal(res.body.data.midtrans_payment_url, 'https://pay.test/retry')
            assert.equal(res.body.data.accessStatus, 'NONE')
            assert.equal(await models.transactionModel.countDocuments({ user: instructor._id, status: 'pending' }), 1)
        })
    })

    it('reuses a recent pending payment page instead of creating a new order each time', async () => {
        const instructor = await createInstructor({ active: false })

        await withProvider(midtransOk('https://pay.test/once'), async (mock) => {
            await request.post('/api/payment/checkout').set(auth(instructor))
            const second = await request.post('/api/payment/checkout').set(auth(instructor))

            assert.equal(second.body.data.midtrans_payment_url, 'https://pay.test/once')
            assert.equal(mock.calls.length, 1)
            assert.equal(await models.transactionModel.countDocuments({ user: instructor._id }), 1)
        })
    })

    it('leaves nothing behind when the provider fails during a retry', async () => {
        const instructor = await createInstructor({ active: false })

        await withProvider(
            () => new Response('{}', { status: 500 }),
            async () => {
                const res = await request.post('/api/payment/checkout').set(auth(instructor))

                assert.equal(res.status, 502)
                assert.equal(await models.transactionModel.countDocuments({ user: instructor._id }), 0)
            }
        )
    })

    it('allows early renewal while the workspace is active and labels it a renewal', async () => {
        const instructor = await createInstructor({ active: true })

        await withProvider(midtransOk('https://pay.test/renew'), async () => {
            const res = await request.post('/api/payment/checkout').set(auth(instructor))

            assert.equal(res.status, 200)
            assert.equal(res.body.data.purpose, 'renewal')
            assert.equal(res.body.data.accessStatus, 'ACTIVE')
        })
    })

    it('is not available to students (403) or anonymous callers (401)', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)

        assert.equal((await request.post('/api/payment/checkout').set(auth(student))).status, 403)
        assert.equal((await request.post('/api/payment/checkout')).status, 401)
    })
})

it('uses a server key that matches the documented derivation', () => {
    assert.equal(
        Buffer.from(process.env.MIDTRANS_AUTH_STRING, 'base64').toString('utf8'),
        `${SERVER_KEY}:`
    )
})
