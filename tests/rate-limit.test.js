import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RATE_LIMITS } from '../src/middlewares/rateLimit.js'
import { securityApp } from './security-app.js'

// Route-specific limits on the abuse-prone endpoints (middlewares/rateLimit.js). These requests are
// refused by validation or by the certificate number pattern before any database work, so the real
// routes run without MongoDB.
const badSignIn = (request, email = 'someone@test.dev') => request.post('/api/sign-in').send({ email, password: '' })
const badSignUp = (request) => request.post('/api/sign-up').send({ name: 'x', email: 'nope', password: '1' })
const verify = (request) => request.get('/api/certificates/verify/NOT-A-NUMBER')

const assertLimited = (res) => {
    assert.equal(res.status, 429)
    assert.equal(res.body.code, 'RATE_LIMITED')
    assert.equal(typeof res.body.message, 'string')
    assert.ok(res.headers['retry-after'], 'Retry-After header')
    assert.ok(res.headers.ratelimit, 'standard RateLimit header')
    // the error contract: nothing else leaks into the body
    assert.deepEqual(Object.keys(res.body).sort(), ['code', 'message'])
}

describe('sign-in', () => {
    it(`allows ${RATE_LIMITS.signInAccount.limit} failed attempts per account, then answers 429`, async () => {
        const request = securityApp({ rateLimits: true })

        for (let i = 0; i < RATE_LIMITS.signInAccount.limit; i += 1) {
            assert.equal((await badSignIn(request)).status, 400, `attempt ${i + 1}`)
        }

        assertLimited(await badSignIn(request))
    })

    it('counts each account separately (another email from the same address is still allowed)', async () => {
        const request = securityApp({ rateLimits: true })

        for (let i = 0; i < RATE_LIMITS.signInAccount.limit; i += 1) await badSignIn(request, 'victim@test.dev')

        assert.equal((await badSignIn(request, 'victim@test.dev')).status, 429)
        assert.equal((await badSignIn(request, 'VICTIM@test.dev ')).status, 429, 'the email is normalized')
        assert.equal((await badSignIn(request, 'other@test.dev')).status, 400)
    })

    it(`stops credential stuffing: ${RATE_LIMITS.signInAddress.limit} failed attempts per address over all accounts`, async () => {
        const request = securityApp({ rateLimits: true })

        for (let i = 0; i < RATE_LIMITS.signInAddress.limit; i += 1) {
            assert.equal((await badSignIn(request, `user${i}@test.dev`)).status, 400)
        }

        assertLimited(await badSignIn(request, 'fresh@test.dev'))
    })

    it('does not throttle the rest of the API', async () => {
        const request = securityApp({ rateLimits: true })

        for (let i = 0; i < RATE_LIMITS.signInAccount.limit + 1; i += 1) await badSignIn(request)

        assert.equal((await badSignIn(request)).status, 429)
        assert.equal((await request.get('/api/health')).status, 200)
        assert.equal((await request.get('/api/me')).status, 401, 'other routes keep their normal answer')
        assert.equal((await verify(request)).status, 404)
    })
})

describe('sign-up', () => {
    it(`allows ${RATE_LIMITS.signUp.limit} attempts per address, then answers 429`, async () => {
        const request = securityApp({ rateLimits: true })

        for (let i = 0; i < RATE_LIMITS.signUp.limit; i += 1) assert.equal((await badSignUp(request)).status, 400)

        assertLimited(await badSignUp(request))
    })
})

describe('public certificate verification', () => {
    it(`allows ${RATE_LIMITS.certificateVerify.limit} lookups per address per minute, then answers 429`, async () => {
        const request = securityApp({ rateLimits: true })

        for (let i = 0; i < RATE_LIMITS.certificateVerify.limit; i += 1) assert.equal((await verify(request)).status, 404)

        assertLimited(await verify(request))
    })
})

describe('isolation and configuration', () => {
    it('every app starts with empty counters', async () => {
        const first = securityApp({ rateLimits: true })

        for (let i = 0; i < RATE_LIMITS.certificateVerify.limit + 1; i += 1) await verify(first)

        assert.equal((await verify(first)).status, 429)
        assert.equal((await verify(securityApp({ rateLimits: true }))).status, 404)
    })

    it('disabled (the default in the automated tests) means no limit at all', async () => {
        const request = securityApp()

        for (let i = 0; i < RATE_LIMITS.certificateVerify.limit + 5; i += 1) assert.equal((await verify(request)).status, 404)
    })

    it('the limits are proportionate: windows and thresholds as documented', () => {
        assert.deepEqual(RATE_LIMITS, {
            signInAccount: { windowMs: 15 * 60 * 1000, limit: 10 },
            signInAddress: { windowMs: 15 * 60 * 1000, limit: 50 },
            signUp: { windowMs: 60 * 60 * 1000, limit: 10 },
            certificateVerify: { windowMs: 60 * 1000, limit: 30 },
            passwordChange: { windowMs: 15 * 60 * 1000, limit: 10 },
        })
    })
})
