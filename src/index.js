import 'dotenv/config'

import { validateConfig } from './config/env.js'
import { ensureUploadDirs } from './config/paths.js'
import connectDB from './utils/database.js'
import { createApp } from './app.js'

let config

try {
    config = validateConfig()
} catch (error) {
    console.error(error.message)
    process.exit(1)
}

ensureUploadDirs()

await connectDB(config.databaseUrl)

createApp().listen(config.port, () => {
    console.log(`LMS Backend listening on port ${config.port}`)
})
