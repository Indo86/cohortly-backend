import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    PASSWORD, PNG, auth, createInstructor, createStudent, mockFetch, midtransOk, models, resetDb, startTestEnv,
    stopTestEnv,
} from './helpers.js'

let request

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(resetDb)

const signIn = (email, password = PASSWORD) => request.post('/api/sign-in').send({ email, password })

describe('email uniqueness', () => {
    it('rejects a duplicate instructor sign-up with 409', async () => {
        await createInstructor({ email: 'taken@test.dev' })
        const fetchMock = mockFetch(midtransOk())

        try {
            const res = await request
                .post('/api/sign-up')
                .send({ name: 'Another Person', email: 'taken@test.dev', password: 'secret-pass-1' })

            assert.equal(res.status, 409)
            assert.equal(res.body.code, 'EMAIL_EXISTS')
            assert.equal(fetchMock.calls.length, 0, 'the payment provider must not be called')
            assert.equal(await models.userModel.countDocuments({ email: 'taken@test.dev' }), 1)
        } finally {
            fetchMock.restore()
        }
    })

    it('treats emails case-insensitively', async () => {
        await createInstructor({ email: 'case@test.dev' })

        const res = await request
            .post('/api/sign-up')
            .send({ name: 'Another Person', email: 'CASE@test.dev', password: 'secret-pass-1' })

        assert.equal(res.status, 409)
    })

    it('rejects a student whose email is already used by any account with 409', async () => {
        const instructor = await createInstructor({ email: 'boss@test.dev' })

        const res = await request
            .post('/api/students')
            .set(auth(instructor))
            .field('name', 'New Student')
            .field('email', 'boss@test.dev')
            .field('password', 'secret-pass-1')
            .attach('avatar', PNG, { filename: 'a.png', contentType: 'image/png' })

        assert.equal(res.status, 409)
    })

    it('enforces uniqueness in the database itself (unique index)', async () => {
        await createInstructor({ email: 'dup@test.dev' })

        await assert.rejects(createInstructor({ email: 'dup@test.dev' }), { code: 11000 })
    })

    it('rejects changing a student email to one that is already in use with 409', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)
        const other = await createStudent(instructor)

        const res = await request
            .put(`/api/students/${student._id}`)
            .set(auth(instructor))
            .field('name', student.name)
            .field('email', other.email)

        assert.equal(res.status, 409)
    })
})

describe('student password safety', () => {
    const edit = (instructor, student, fields) => {
        let req = request.put(`/api/students/${student._id}`).set(auth(instructor))

        for (const [key, value] of Object.entries(fields)) req = req.field(key, value)

        return req
    }

    it('keeps the password when none is sent', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)

        const res = await edit(instructor, student, { name: 'Renamed Student', email: student.email })

        assert.equal(res.status, 200)
        assert.equal((await signIn(student.email)).status, 200)
        assert.equal((await models.userModel.findById(student._id)).name, 'Renamed Student')
    })

    for (const placeholder of ['undefined', 'null', '']) {
        it(`keeps the password when the stringified placeholder "${placeholder}" is sent`, async () => {
            const instructor = await createInstructor()
            const student = await createStudent(instructor)

            const res = await edit(instructor, student, {
                name: 'Renamed Student',
                email: student.email,
                password: placeholder,
            })

            assert.equal(res.status, 200)
            assert.equal((await signIn(student.email)).status, 200, 'old password must still work')
            assert.equal((await signIn(student.email, placeholder || 'x')).status, 401)
        })
    }

    it('changes the password only when a valid one is supplied', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)

        const res = await edit(instructor, student, {
            name: student.name,
            email: student.email,
            password: 'brand-new-pass',
        })

        assert.equal(res.status, 200)
        assert.equal((await signIn(student.email, 'brand-new-pass')).status, 200)
        assert.equal((await signIn(student.email)).status, 401)
    })

    it('rejects a supplied password that is too short instead of silently ignoring it', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)

        const res = await edit(instructor, student, { name: student.name, email: student.email, password: 'abc' })

        assert.equal(res.status, 400)
        assert.equal((await signIn(student.email)).status, 200)
    })

    it('never stores or returns the password hash in responses', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)

        const list = await request.get('/api/students').set(auth(instructor))
        const one = await request.get(`/api/students/${student._id}`).set(auth(instructor))

        assert.equal(JSON.stringify(list.body).includes('password'), false)
        assert.equal(JSON.stringify(one.body).includes('password'), false)
    })
})
