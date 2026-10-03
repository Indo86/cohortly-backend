import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    auth, createCategory, createCourse, createInstructor, createSection, models, resetDb, startTestEnv, stopTestEnv,
} from './helpers.js'

let request
let instructor
let category
let course

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(async () => {
    await resetDb()
    instructor = await createInstructor()
    category = await createCategory()
    course = await createCourse(instructor, category)
})

describe('error contract: invalid input is a 4xx, never a 500', () => {
    it('answers 400 with a field error list for an invalid sign-up', async () => {
        const res = await request.post('/api/sign-up').send({ name: 'x', email: 'nope', password: '1' })

        assert.equal(res.status, 400)
        assert.equal(res.body.message, 'Validation error')
        assert.deepEqual(res.body.errors.map((e) => e.path).sort(), ['email', 'name', 'password'])
    })

    it('answers 400 for malformed JSON', async () => {
        const res = await request
            .post('/api/sign-in')
            .set('Content-Type', 'application/json')
            .send('{"email": ')

        assert.equal(res.status, 400)
        assert.equal(res.body.message, 'Malformed JSON body')
    })

    it('answers 400 for a course with missing fields', async () => {
        const res = await request.post('/api/courses').set(auth(instructor)).field('name', 'ab')

        assert.equal(res.status, 400)
        assert.equal(res.body.message, 'Validation error')
    })

    it('answers 400 when the course thumbnail is missing', async () => {
        const res = await request
            .post('/api/courses')
            .set(auth(instructor))
            .field('name', 'Valid course name')
            .field('tagline', 'Valid tagline')
            .field('description', 'Valid description text')
            .field('categoryId', category._id.toString())

        assert.equal(res.status, 400)
        assert.equal(res.body.message, 'Thumbnail is required')
    })

    it('answers 400 for a malformed id in the path', async () => {
        const res = await request.get('/api/courses/not-an-id').set(auth(instructor))

        assert.equal(res.status, 400)
    })

    it('answers 404 for a well-formed id that does not exist', async () => {
        const res = await request.get('/api/courses/64b64b64b64b64b64b64b64b').set(auth(instructor))

        assert.equal(res.status, 404)
    })

    it('answers 404 with JSON for an unknown route', async () => {
        const res = await request.get('/api/does-not-exist')

        assert.equal(res.status, 404)
        assert.equal(res.body.message, 'Route not found')
    })

    it('rejects an invalid content type and a missing payload for the chosen type with 400', async () => {
        const section = await createSection(course)
        const base = { title: 'Lesson title' }
        const post = (body) => request.post(`/api/sections/${section._id}/lessons`).set(auth(instructor)).send(body)

        assert.equal((await post({ ...base, type: 'audio' })).status, 400)
        assert.equal((await post({ ...base, type: 'video' })).status, 400)
        assert.equal((await post({ ...base, type: 'video', youtubeId: '../evil?x=1' })).status, 400)
        assert.equal((await post({ ...base, type: 'text' })).status, 400)
        assert.equal((await post({ ...base, type: 'text', text: '<p>fine content</p>' })).status, 201)
    })

    it('answers 400 for a malformed section or lesson id in the path', async () => {
        const body = { title: 'Lesson title', type: 'text', text: '<p>content</p>' }

        assert.equal((await request.post('/api/sections/oops/lessons').set(auth(instructor)).send(body)).status, 400)
        assert.equal((await request.get('/api/lessons/oops').set(auth(instructor))).status, 400)
        assert.equal((await request.get('/api/courses/oops/sections').set(auth(instructor))).status, 400)
    })

    it('answers 400 when enrolling with a malformed student id', async () => {
        const res = await request
            .post(`/api/courses/students/${course._id}`)
            .set(auth(instructor))
            .send({ studentId: 'oops' })

        assert.equal(res.status, 400)
    })

    it('does not leak internals in error bodies', async () => {
        const res = await request.get('/api/courses/not-an-id').set(auth(instructor))

        assert.equal(/stack|mongoose|at \w+/i.test(JSON.stringify(res.body)), false)
        assert.equal(await models.courseModel.countDocuments(), 1)
    })
})

describe('configuration', () => {
    it('reports healthy on /api/health and no longer exposes debug routes', async () => {
        assert.equal((await request.get('/api/health')).body.status, 'ok')
        assert.equal((await request.get('/api/hello-world')).status, 404)
        assert.equal((await request.post('/api/test-validate').send({})).status, 404)
        assert.equal((await request.get('/')).status, 404)
    })

    it('only allows the configured frontend origin for CORS', async () => {
        const allowed = await request.get('/api/health').set('Origin', 'http://app.test')
        const denied = await request.get('/api/health').set('Origin', 'http://evil.test')

        assert.equal(allowed.headers['access-control-allow-origin'], 'http://app.test')
        assert.equal(denied.headers['access-control-allow-origin'], undefined)
    })
})
