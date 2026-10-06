// A database-free app for the security tests (M2): the routes they exercise answer before any query
// (health, validation errors, malformed certificate numbers, token checks that precede the user lookup).
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.NODE_ENV = 'test'
process.env.SECRET_KEY_JWT = 'test-secret-key-at-least-16-chars'
process.env.APP_URL = 'http://api.test'
process.env.FRONTEND_URL = 'http://app.test'
process.env.PUBLIC_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'lms-security-'))

const { default: supertest } = await import('supertest')
const { createApp } = await import('../src/app.js')

// A fresh app (and therefore fresh rate-limit counters). `rateLimits` switches the limiters on.
export const securityApp = ({ rateLimits = false } = {}) => {
    const previous = process.env.RATE_LIMIT_ENABLED

    process.env.RATE_LIMIT_ENABLED = String(rateLimits)

    try {
        return supertest(createApp())
    } finally {
        if (previous === undefined) delete process.env.RATE_LIMIT_ENABLED
        else process.env.RATE_LIMIT_ENABLED = previous
    }
}
