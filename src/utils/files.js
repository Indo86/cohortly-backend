import fs from 'fs'
import path from 'path'
import { UPLOAD_DIR } from '../config/paths.js'

// Deletes an uploaded file by stored name. Only plain file names inside the
// given upload folder are honoured, so stored values can never escape it.
export const removeUpload = (folder, storedName) => {
    if (!storedName || storedName === 'default.png') return

    const filePath = path.join(UPLOAD_DIR, folder, path.basename(storedName))

    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch (error) {
        console.error('Could not remove upload:', error.message)
    }
}

// Removes a file multer just wrote (used when the request is rejected afterwards).
export const removeUploadedFile = (file) => {
    if (file?.path && fs.existsSync(file.path)) {
        try {
            fs.unlinkSync(file.path)
        } catch (error) {
            console.error('Could not remove upload:', error.message)
        }
    }
}
