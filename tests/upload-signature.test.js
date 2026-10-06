import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { verifyImageContent } from '../src/utils/multer.js'

// The second upload gate (utils/multer.js verifyImageContent): the real type comes from the file's
// signature, never from the declared MIME type or the name. Runs on files in a temporary folder.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
// smallest JPEG signature followed by a JFIF header
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

let dir

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-upload-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

// what multer leaves on req.file: a stored file named after the DECLARED type
const stored = (buffer, mimetype) => {
    const filename = `thumbnail-123e4567-e89b-12d3-a456-426614174000.${mimetype === 'image/png' ? 'png' : 'jpg'}`
    const filePath = path.join(dir, filename)

    fs.writeFileSync(filePath, buffer)

    return { fieldname: 'thumbnail', filename, path: filePath, mimetype, size: buffer.length }
}

const run = async (file) => {
    const req = { file }
    const error = await new Promise((resolve) => verifyImageContent(req, {}, resolve))

    return { req, error }
}

describe('upload content check (file signature)', () => {
    it('accepts a real PNG and a real JPEG and keeps them', async () => {
        for (const [buffer, mimetype, extension] of [[PNG, 'image/png', '.png'], [JPEG, 'image/jpeg', '.jpg']]) {
            const file = stored(buffer, mimetype)
            const { req, error } = await run(file)

            assert.equal(error, undefined)
            assert.equal(req.file.mimetype, mimetype)
            assert.equal(path.extname(req.file.filename), extension)
            assert.equal(fs.existsSync(req.file.path), true)
        }
    })

    it('refuses a fake image (text declared as image/png), deletes it and answers 400', async () => {
        const file = stored(Buffer.from('<?php system($_GET["c"]); ?>'), 'image/png')
        const { req, error } = await run(file)

        assert.equal(error.status, 400)
        assert.equal(error.message, 'The file is not a valid JPEG or PNG image')
        assert.equal(req.file, undefined)
        assert.equal(fs.existsSync(file.path), false)
        assert.deepEqual(fs.readdirSync(dir), [])
    })

    it('refuses an unsupported real image type (GIF declared as image/jpeg)', async () => {
        const file = stored(GIF, 'image/jpeg')
        const { error } = await run(file)

        assert.equal(error.status, 400)
        assert.deepEqual(fs.readdirSync(dir), [])
    })

    it('refuses an empty file', async () => {
        const { error } = await run(stored(Buffer.alloc(0), 'image/png'))

        assert.equal(error.status, 400)
        assert.deepEqual(fs.readdirSync(dir), [])
    })

    it('stores a real image under the extension of what it really is (PNG declared as JPEG becomes .png)', async () => {
        const file = stored(PNG, 'image/jpeg')
        const { req, error } = await run(file)

        assert.equal(error, undefined)
        assert.equal(req.file.mimetype, 'image/png')
        assert.match(req.file.filename, /^thumbnail-[0-9a-f-]{36}\.png$/)
        assert.deepEqual(fs.readdirSync(dir), [req.file.filename])
    })

    it('does nothing without a file (uploads are optional on some routes)', async () => {
        const { error } = await run(undefined)

        assert.equal(error, undefined)
    })
})
