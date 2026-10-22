import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import {
    PNG, auth, createInstructor, createStudent, models, publicDir, resetDb, startTestEnv, stopTestEnv,
} from './helpers.js'

// The signed-in user's own avatar (PUT /api/me/avatar) and the photo_url every view shows for it.
let request

const avatarDir = path.join(publicDir, 'uploads', 'students')
const stored = () => (fs.existsSync(avatarDir) ? fs.readdirSync(avatarDir) : [])
const upload = (user, file = { buffer: PNG, filename: 'me.png', contentType: 'image/png' }) => {
    const req = request.put('/api/me/avatar').set(auth(user))

    return file ? req.attach('avatar', file.buffer, { filename: file.filename, contentType: file.contentType }) : req
}

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(resetDb)

describe('own avatar', () => {
    it('has no photo_url until an avatar is uploaded (the client shows initials)', async () => {
        const instructor = await createInstructor()

        const res = await request.get('/api/me').set(auth(instructor))

        assert.equal(res.status, 200)
        assert.equal(res.body.data.photo_url, null)
    })

    it('lets an instructor upload one and see it in /me', async () => {
        const instructor = await createInstructor()

        const res = await upload(instructor)

        assert.equal(res.status, 200)
        assert.match(res.body.data.photo_url, /\/uploads\/students\/avatar-.+\.png$/)

        const me = await request.get('/api/me').set(auth(instructor))

        assert.equal(me.body.data.photo_url, res.body.data.photo_url)
    })

    it('lets a student upload one; the instructor sees it in the student views', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)

        const res = await upload(student)

        assert.equal(res.status, 200)

        const detail = await request.get(`/api/students/${student._id}`).set(auth(instructor))
        const list = await request.get('/api/students').set(auth(instructor))

        assert.equal(detail.body.data.photo_url, res.body.data.photo_url)
        assert.equal(list.body.data.find((item) => item._id === String(student._id)).photo_url, res.body.data.photo_url)
    })

    it('replaces the old file instead of piling them up', async () => {
        const instructor = await createInstructor()

        await upload(instructor)
        await upload(instructor)

        assert.equal(stored().length, 1)
    })

    it('rejects a missing file, a non-image and anonymous callers, storing nothing', async () => {
        const instructor = await createInstructor()

        assert.equal((await upload(instructor, null)).status, 400)
        assert.equal(
            (await upload(instructor, { buffer: Buffer.from('<?php ?>'), filename: 'x.png', contentType: 'image/png' })).status,
            400
        )
        assert.equal(
            (await request.put('/api/me/avatar').attach('avatar', PNG, { filename: 'a.png', contentType: 'image/png' })).status,
            401
        )
        assert.equal(stored().length, 0)
        assert.equal((await models.userModel.findById(instructor._id)).photo, 'default.png')
    })
})
