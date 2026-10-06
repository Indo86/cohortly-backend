import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { securityApp } from './security-app.js'

// Helmet baseline (src/app.js). Only the headers that matter are asserted, not Helmet's whole set.
describe('HTTP security headers', () => {
    it('are sent on API responses', async () => {
        const res = await securityApp().get('/api/health')

        assert.equal(res.status, 200)
        assert.equal(res.headers['x-content-type-options'], 'nosniff')
        assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN')
        assert.match(res.headers['strict-transport-security'], /max-age=\d+/)
        assert.match(res.headers['content-security-policy'], /default-src 'self'/)
        assert.match(res.headers['content-security-policy'], /frame-ancestors 'self'/)
        assert.equal(res.headers['referrer-policy'], 'no-referrer')
        assert.equal(res.headers['x-powered-by'], undefined)
    })

    it('let the frontend (another origin) display uploaded images', async () => {
        const res = await securityApp().get('/api/health')

        assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin')
    })

    it('are also sent on errors (404 and validation)', async () => {
        const request = securityApp()

        for (const res of [await request.get('/api/nope'), await request.post('/api/sign-in').send({})]) {
            assert.equal(res.headers['x-content-type-options'], 'nosniff')
            assert.ok(res.headers['content-security-policy'])
        }
    })

    it('do not break CORS for the frontend origin', async () => {
        const res = await securityApp().get('/api/health').set('Origin', 'http://app.test')

        assert.equal(res.headers['access-control-allow-origin'], 'http://app.test')
    })
})
