import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import {
    PNG, auth, createCategory, createInstructor, createStudent, models, publicDir, resetDb, startTestEnv, stopTestEnv,
} from './helpers.js'

let request
let instructor
let category

const uploads = (folder) => path.join(publicDir, 'uploads', folder)
const files = (folder) => (fs.existsSync(uploads(folder)) ? fs.readdirSync(uploads(folder)) : [])

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(async () => {
    await resetDb()
    instructor = await createInstructor()
    category = await createCategory()
})

const createCourseRequest = (file = { buffer: PNG, filename: 'cover.png', contentType: 'image/png' }) => {
    let req = request
        .post('/api/courses')
        .set(auth(instructor))
        .field('name', 'Valid course name')
        .field('tagline', 'Valid tagline')
        .field('description', 'Valid description text')
        .field('categoryId', category._id.toString())

    if (file) req = req.attach('thumbnail', file.buffer, { filename: file.filename, contentType: file.contentType })

    return req
}

describe('upload hardening', () => {
    it('works on a fresh install where the upload folders do not exist yet', async () => {
        assert.equal(fs.existsSync(uploads('courses')), false)

        const res = await createCourseRequest()

        assert.equal(res.status, 200)
        assert.equal(files('courses').length, 1)
    })

    it('generates a safe stored name and ignores the original file name (multi-dot, traversal)', async () => {
        const res = await createCourseRequest({
            buffer: PNG,
            filename: '../../evil.name.with.dots.php.png',
            contentType: 'image/png',
        })

        assert.equal(res.status, 200)

        const [stored] = files('courses')
        assert.match(stored, /^thumbnail-[0-9a-f-]{36}\.png$/)
        assert.equal(fs.existsSync(path.join(publicDir, 'evil.name.with.dots.php.png')), false)
    })

    it('derives the extension from the validated MIME type, not from the name', async () => {
        const res = await createCourseRequest({ buffer: PNG, filename: 'photo.exe', contentType: 'image/jpeg' })

        assert.equal(res.status, 200)
        assert.match(files('courses')[0], /\.jpg$/)
    })

    it('rejects non-image uploads with 400 and stores nothing', async () => {
        const res = await createCourseRequest({
            buffer: Buffer.from('<?php echo 1; ?>'),
            filename: 'shell.php',
            contentType: 'application/x-php',
        })

        assert.equal(res.status, 400)
        assert.equal(await models.courseModel.countDocuments(), 0)
        assert.equal(files('courses').length, 0)
    })

    it('rejects files over the size limit with 413', async () => {
        const res = await createCourseRequest({
            buffer: Buffer.alloc(2 * 1024 * 1024 + 1024, 1),
            filename: 'big.png',
            contentType: 'image/png',
        })

        assert.equal(res.status, 413)
        assert.equal(files('courses').length, 0)
    })

    it('removes the uploaded file when validation fails afterwards', async () => {
        const res = await request
            .post('/api/courses')
            .set(auth(instructor))
            .field('name', 'x')
            .attach('thumbnail', PNG, { filename: 'cover.png', contentType: 'image/png' })

        assert.equal(res.status, 400)
        assert.equal(files('courses').length, 0)
    })

    it('does not accept uploads from anonymous callers or students (nothing written)', async () => {
        const student = await createStudent(instructor)

        const anonymous = await request.post('/api/courses').attach('thumbnail', PNG, { filename: 'a.png', contentType: 'image/png' })
        const asStudent = await request
            .post('/api/courses')
            .set(auth(student))
            .attach('thumbnail', PNG, { filename: 'a.png', contentType: 'image/png' })

        assert.equal(anonymous.status, 401)
        assert.equal(asStudent.status, 403)
        assert.equal(files('courses').length, 0)
    })

    it('replaces and cleans up the old thumbnail on update, and removes it on delete', async () => {
        await createCourseRequest()
        const course = await models.courseModel.findOne()
        const first = course.thumbnail
        assert.deepEqual(files('courses'), [first])

        const update = await request
            .put(`/api/courses/${course._id}`)
            .set(auth(instructor))
            .field('name', 'Renamed course')
            .field('tagline', 'New tagline')
            .field('description', 'New description text')
            .field('categoryId', category._id.toString())
            .attach('thumbnail', PNG, { filename: 'second.png', contentType: 'image/png' })

        assert.equal(update.status, 200)
        assert.equal(files('courses').length, 1)
        assert.notEqual(files('courses')[0], first)

        const del = await request.delete(`/api/courses/${course._id}`).set(auth(instructor))
        assert.equal(del.status, 200)
        assert.equal(files('courses').length, 0)
    })

    it('requires an avatar for new students and stores it safely; replaces it on update', async () => {
        const base = () =>
            request
                .post('/api/students')
                .set(auth(instructor))
                .field('name', 'Student Name')
                .field('email', 'student@new.dev')
                .field('password', 'secret-pass-1')

        assert.equal((await base()).status, 400)

        const created = await base().attach('avatar', PNG, { filename: 'me.png', contentType: 'image/png' })
        assert.equal(created.status, 200)
        assert.equal(files('students').length, 1)

        const student = await models.userModel.findOne({ email: 'student@new.dev' })
        const update = await request
            .put(`/api/students/${student._id}`)
            .set(auth(instructor))
            .field('name', 'Student Name')
            .field('email', 'student@new.dev')
            .attach('avatar', PNG, { filename: 'new.png', contentType: 'image/png' })

        assert.equal(update.status, 200)
        assert.equal(files('students').length, 1)

        await request.delete(`/api/students/${student._id}`).set(auth(instructor))
        assert.equal(files('students').length, 0)
    })

    it('never deletes the shared default avatar file reference', async () => {
        const student = await createStudent(instructor)

        const res = await request.delete(`/api/students/${student._id}`).set(auth(instructor))

        assert.equal(res.status, 200)
    })
})
