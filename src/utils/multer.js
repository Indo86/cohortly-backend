import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { UPLOAD_DIR } from '../config/paths.js'
import { badRequest } from './httpError.js'

const MAX_IMAGE_BYTES = 2 * 1024 * 1024

// The stored extension comes from the validated MIME type, never from the
// client-supplied file name.
const EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
}

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

// Returns a multer middleware for a single image field stored in uploads/<folder>.
export const uploadImage = (folder, fieldName) =>
    multer({
        storage: diskStorage(folder),
        fileFilter,
        limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
    }).single(fieldName)
