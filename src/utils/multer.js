import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { fileTypeFromFile } from 'file-type'
import { UPLOAD_DIR } from '../config/paths.js'
import { badRequest } from './httpError.js'

// Image uploads (course thumbnails, student avatars): JPEG or PNG, at most 2 MB, one file per request.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

// The allowlist: content type -> stored extension. The stored extension never comes from the
// client-supplied file name.
const EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
}

// First gate (before anything is written): the type the client declares must be on the allowlist.
// It is only a claim, so verifyImageContent checks the actual bytes afterwards.
export const fileFilter = (req, file, cb) => {
    if (EXTENSIONS[file.mimetype]) {
        cb(null, true)
    } else {
        cb(badRequest('Only JPEG and PNG images are allowed'))
    }
}

const diskStorage = (folder) =>
    multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(UPLOAD_DIR, folder)

            fs.mkdirSync(dir, { recursive: true })
            cb(null, dir)
        },
        filename: (req, file, cb) => {
            cb(null, `${file.fieldname}-${crypto.randomUUID()}.${EXTENSIONS[file.mimetype]}`)
        },
    })

const discard = (file) => {
    try {
        fs.rmSync(file.path, { force: true })
    } catch (error) {
        console.error('Could not remove upload:', error.message)
    }
}

// Second gate (after multer stored the file): the real type is read from the file's signature (magic
// bytes, `file-type`), not from the declared MIME type or the name. Anything that is not really a JPEG
// or PNG is deleted and refused with 400. A real image declared as the other type is kept, and its
// stored name gets the extension of what it actually is.
export const verifyImageContent = async (req, res, next) => {
    const file = req.file

    if (!file) return next()

    try {
        const detected = await fileTypeFromFile(file.path)
        const extension = EXTENSIONS[detected?.mime]

        if (!extension) {
            discard(file)
            req.file = undefined

            return next(badRequest('The file is not a valid JPEG or PNG image'))
        }

        if (path.extname(file.filename) !== `.${extension}`) {
            const filename = `${path.basename(file.filename, path.extname(file.filename))}.${extension}`
            const target = path.join(path.dirname(file.path), filename)

            fs.renameSync(file.path, target)
            Object.assign(file, { filename, path: target })
        }

        file.mimetype = detected.mime

        return next()
    } catch (error) {
        discard(file)
        req.file = undefined

        return next(error)
    }
}

// Returns the middleware chain for a single image field stored in uploads/<folder>: multer (declared
// type allowlist, size and count limits, safe generated name) and then the content check.
export const uploadImage = (folder, fieldName) => [
    multer({
        storage: diskStorage(folder),
        fileFilter,
        limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
    }).single(fieldName),
    verifyImageContent,
]
