import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import {
    PASSWORD, auth, createInstructor, createStudent, models, resetDb, startTestEnv, stopTestEnv, tokenFor,
} from './helpers.js'

let request

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(resetDb)

describe('sign-in', () => {
    it('returns a token, role and access status for valid instructor credentials', async () => {
        const instructor = await createInstructor()

        const res = await request.post('/api/sign-in').send({ email: instructor.email, password: PASSWORD })

        assert.equal(res.status, 200)
        assert.equal(res.body.data.role, 'manager')
        assert.equal(res.body.data.accessStatus, 'ACTIVE')
        assert.ok(res.body.data.token)
        assert.equal(res.body.data.password, undefined)
    })

    it('lets a student sign in and reports the workspace entitlement of their instructor', async () => {
        const instructor = await createInstructor({ active: false })
        const student = await createStudent(instructor)

        const res = await request.post('/api/sign-in').send({ email: student.email, password: PASSWORD })

        assert.equal(res.status, 200)
        assert.equal(res.body.data.role, 'student')
        assert.equal(res.body.data.accessStatus, 'NONE')
        assert.equal(res.body.data.accessExpiresAt, null)
    })

    it('matches the email case-insensitively', async () => {
        const instructor = await createInstructor({ email: 'mixed@test.dev' })

        const res = await request.post('/api/sign-in').send({ email: 'MiXed@Test.dev', password: PASSWORD })

        assert.equal(res.status, 200)
        assert.equal(res.body.data.email, instructor.email)
    })

    it('rejects a wrong password with 401', async () => {
        const instructor = await createInstructor()

        const res = await request.post('/api/sign-in').send({ email: instructor.email, password: 'wrong-pass' })

        assert.equal(res.status, 401)
        assert.equal(res.body.message, 'Email / password incorrect')
    })

    it('answers an unknown email exactly like a wrong password (no account enumeration)', async () => {
        const res = await request.post('/api/sign-in').send({ email: 'nobody@test.dev', password: 'whatever1' })

        assert.equal(res.status, 401)
        assert.equal(res.body.message, 'Email / password incorrect')
    })

    it('rejects a malformed body with 400, not 500', async () => {
        const res = await request.post('/api/sign-in').send({ email: 'not-an-email' })

        assert.equal(res.status, 400)
        assert.ok(Array.isArray(res.body.errors))
    })
})

describe('token verification', () => {
    const protectedUrl = '/api/me'

    it('rejects a missing token with 401', async () => {
        const res = await request.get(protectedUrl)

        assert.equal(res.status, 401)
    })

    for (const [label, header] of [
        ['wrong scheme', 'Bearer abc'],
        ['scheme only', 'JWT'],
        ['too many parts', 'JWT a b'],
        ['garbage token', 'JWT not.a.token'],
        ['empty token', 'JWT '],
    ]) {
        it(`rejects a malformed Authorization header (${label}) with 401`, async () => {
            const res = await request.get(protectedUrl).set('Authorization', header)

            assert.equal(res.status, 401)
            assert.equal(res.body.message.includes('jwt'), false)
        })
    }

    it('rejects an expired token with 401', async () => {
        const instructor = await createInstructor()
        const token = tokenFor(instructor, { expiresIn: -10 })

        const res = await request.get(protectedUrl).set('Authorization', `JWT ${token}`)

        assert.equal(res.status, 401)
        assert.equal(res.body.message, 'Invalid or expired token')
    })

    it('rejects a token signed with another secret with 401', async () => {
        const instructor = await createInstructor()
        const token = jwt.sign({ data: { id: instructor._id.toString() } }, 'another-secret-another-secret')

        const res = await request.get(protectedUrl).set('Authorization', `JWT ${token}`)

        assert.equal(res.status, 401)
    })

    it('rejects an unsigned (alg none) token with 401', async () => {
        const instructor = await createInstructor()
        const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
        const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ data: { id: instructor._id.toString() } })}.`

        const res = await request.get(protectedUrl).set('Authorization', `JWT ${token}`)

        assert.equal(res.status, 401)
    })

    it('rejects a token whose payload has no valid user id with 401', async () => {
        const token = jwt.sign({ data: { id: 'nope' } }, process.env.SECRET_KEY_JWT)

        const res = await request.get(protectedUrl).set('Authorization', `JWT ${token}`)

        assert.equal(res.status, 401)
    })

    it('rejects a valid token of a user that no longer exists with 401', async () => {
        const instructor = await createInstructor()
        const headers = auth(instructor)
        await models.userModel.deleteOne({ _id: instructor._id })

        const res = await request.get(protectedUrl).set(headers)

        assert.equal(res.status, 401)
    })

    it('accepts a valid token and exposes identity and access status', async () => {
        const instructor = await createInstructor()

        const res = await request.get(protectedUrl).set(auth(instructor))

        assert.equal(res.status, 200)
        assert.equal(res.body.data.email, instructor.email)
        assert.equal(res.body.data.accessStatus, 'ACTIVE')
    })
})
