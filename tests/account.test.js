import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcrypt'
import supertest from 'supertest'
import {
    PASSWORD, auth, createInstructor, createStudent, models, pay, resetDb, startTestEnv, stopTestEnv, daysAgo,
} from './helpers.js'

// M3: the signed-in user's own password change (PUT /api/me/password) and credential invalidation.
let request

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(resetDb)

const NEW_PASSWORD = 'a-brand-new-password'

const signIn = (email, password = PASSWORD, app = request) => app.post('/api/sign-in').send({ email, password })
const tokenOf = async (user, password = PASSWORD) => {
    const res = await signIn(user.email, password)

    assert.equal(res.status, 200, 'sign-in')

    return res.body.data.token
}
const bearer = (token) => ({ Authorization: `JWT ${token}` })
const me = (token) => request.get('/api/me').set(bearer(token))
const change = (token, body, app = request) => app.put('/api/me/password').set(bearer(token)).send(body)

describe('changing one\'s own password', () => {
    it('works with the right current password and a valid new one; the response holds no secret', async () => {
        const instructor = await createInstructor()
        const token = await tokenOf(instructor)

        const res = await change(token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })

        assert.equal(res.status, 200)
        assert.deepEqual(res.body, { message: 'Password changed. Please sign in again.' })

        const stored = await models.userModel.findById(instructor._id)

        assert.equal(await bcrypt.compare(NEW_PASSWORD, stored.password), true, 'stored as a bcrypt hash')
        assert.notEqual(stored.password, NEW_PASSWORD)
        assert.ok(stored.passwordChangedAt instanceof Date)
    })

    it('then the old password no longer signs in and the new one does', async () => {
        const student = await createStudent(await createInstructor())

        assert.equal((await change(await tokenOf(student), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 200)
        assert.equal((await signIn(student.email)).status, 401)
        assert.equal((await signIn(student.email, NEW_PASSWORD)).status, 200)
    })

    it('invalidates every token issued before the change (including the one used for it); a new sign-in works at once', async () => {
        const instructor = await createInstructor()
        const [first, second] = [await tokenOf(instructor), await tokenOf(instructor)]

        assert.equal((await me(first)).status, 200)
        assert.equal((await change(first, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 200)

        for (const old of [first, second]) {
            const res = await me(old)

            assert.equal(res.status, 401)
            assert.equal(res.body.message, 'Invalid or expired token')
        }

        // the very same second: still valid, because the token carries the current credential stamp
        const fresh = await tokenOf(instructor, NEW_PASSWORD)

        assert.equal((await me(fresh)).status, 200)
        assert.equal((await request.get('/api/courses').set(bearer(fresh))).status, 200)
    })

    it('a second change invalidates the tokens of the first one', async () => {
        const instructor = await createInstructor()

        assert.equal((await change(await tokenOf(instructor), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 200)

        const afterFirst = await tokenOf(instructor, NEW_PASSWORD)

        assert.equal((await change(afterFirst, { currentPassword: NEW_PASSWORD, newPassword: 'yet-another-password' })).status, 200)
        assert.equal((await me(afterFirst)).status, 401)
        assert.equal((await me(await tokenOf(instructor, 'yet-another-password'))).status, 200)
    })

    it('is available to students and to instructors whose workspace is not active', async () => {
        const expired = await createInstructor({ active: false })

        await pay(expired, { paidAt: daysAgo(90) })

        const student = await createStudent(expired)

        assert.equal((await change(await tokenOf(expired), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 200)
        assert.equal((await change(await tokenOf(student), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 200)
    })
})

describe('refusals change nothing', () => {
    const assertUnchanged = async (user, token) => {
        assert.equal((await signIn(user.email)).status, 200, 'the old password still works')
        assert.equal((await me(token)).status, 200, 'the session is still valid')
        assert.equal((await models.userModel.findById(user._id)).passwordChangedAt, undefined)
    }

    it('a wrong current password is a 400 on the currentPassword field', async () => {
        const instructor = await createInstructor()
        const token = await tokenOf(instructor)

        const res = await change(token, { currentPassword: 'not-my-password', newPassword: NEW_PASSWORD })

        assert.equal(res.status, 400)
        assert.equal(res.body.code, 'CURRENT_PASSWORD_INCORRECT')
        assert.equal(res.body.message, 'Current password is incorrect.')
        assert.deepEqual(res.body.errors, [{ path: 'currentPassword', message: 'Current password is incorrect.' }])
        await assertUnchanged(instructor, token)
    })

    it('a new password below the policy, a reused password and missing fields are validation errors', async () => {
        const instructor = await createInstructor()
        const token = await tokenOf(instructor)

        const weak = await change(token, { currentPassword: PASSWORD, newPassword: 'short12' })
        const same = await change(token, { currentPassword: PASSWORD, newPassword: PASSWORD })
        const empty = await change(token, {})

        assert.equal(weak.status, 400)
        assert.deepEqual(weak.body.errors.map((e) => e.path), ['newPassword'])
        assert.equal(same.status, 400)
        assert.deepEqual(same.body.errors, [{ path: 'newPassword', message: 'Choose a new password that is different from the current one' }])
        assert.equal(empty.status, 400)
        assert.deepEqual(empty.body.errors.map((e) => e.path).sort(), ['currentPassword', 'newPassword'])
        await assertUnchanged(instructor, token)
    })

    it('needs a valid session (401)', async () => {
        assert.equal((await request.put('/api/me/password').send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 401)
        assert.equal((await change('not-a-token', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 401)
    })
})

describe('only one\'s own account', () => {
    it('a user id in the body is ignored: the caller\'s password changes, nobody else\'s', async () => {
        const instructor = await createInstructor()
        const victim = await createStudent(instructor)
        const victimToken = await tokenOf(victim)

        const res = await change(await tokenOf(instructor), {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
            userId: victim._id.toString(),
            _id: victim._id.toString(),
            email: victim.email,
        })

        assert.equal(res.status, 200)
        assert.equal((await signIn(instructor.email, NEW_PASSWORD)).status, 200)
        assert.equal((await signIn(victim.email)).status, 200, 'the other account keeps its password')
        assert.equal((await me(victimToken)).status, 200, 'and its sessions')
    })

    it('knowing another account\'s password does not help: the current password is checked against the caller', async () => {
        const instructor = await createInstructor()
        const other = await createStudent(instructor)

        await models.userModel.updateOne({ _id: other._id }, { password: await bcrypt.hash('the-other-password', 4) })

        const res = await change(await tokenOf(instructor), { currentPassword: 'the-other-password', newPassword: NEW_PASSWORD })

        assert.equal(res.status, 400)
        assert.equal(res.body.code, 'CURRENT_PASSWORD_INCORRECT')
    })
})

describe('deleted accounts', () => {
    it('a deleted student\'s token stops working at once (the account is looked up on every request)', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)
        const token = await tokenOf(student)

        assert.equal((await me(token)).status, 200)
        assert.equal((await request.delete(`/api/students/${student._id}`).set(auth(instructor))).status, 200)
        assert.equal((await me(token)).status, 401)
        assert.equal((await change(token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 401)
        assert.equal((await signIn(student.email)).status, 401)
    })
})

describe('rate limit on failed password changes', () => {
    const limitedApp = async () => {
        const { createApp } = await import('../src/app.js')

        process.env.RATE_LIMIT_ENABLED = 'true'

        try {
            return supertest(createApp())
        } finally {
            delete process.env.RATE_LIMIT_ENABLED
        }
    }

    it('10 wrong current passwords per account, then 429; other accounts are not affected', async () => {
        const limited = await limitedApp()
        const [a, b] = [await createInstructor(), await createInstructor()]
        const [tokenA, tokenB] = [await tokenOf(a), await tokenOf(b)]

        for (let i = 0; i < 10; i += 1) {
            assert.equal((await change(tokenA, { currentPassword: `guess-${i}`, newPassword: NEW_PASSWORD }, limited)).status, 400)
        }

        const blocked = await change(tokenA, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, limited)

        assert.equal(blocked.status, 429)
        assert.equal(blocked.body.code, 'RATE_LIMITED')
        assert.equal((await change(tokenB, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, limited)).status, 200)
    })
})
