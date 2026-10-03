import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const PUBLIC_DIR = process.env.PUBLIC_DIR
    ? path.resolve(process.env.PUBLIC_DIR)
    : path.resolve(here, '../../public')
export const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads')

export const ensureUploadDirs = () => {
    for (const sub of ['courses', 'students']) {
        fs.mkdirSync(path.join(UPLOAD_DIR, sub), { recursive: true })
    }
}
