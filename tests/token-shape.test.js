import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { securityApp } from './security-app.js'

// Token checks that happen before the user lookup (middlewares/verifyToken.js), so no database is needed.
const ID = '64b64b64b64b64b64b64b64b'
const me = (token) => securityApp().get('/api/me').set('Authorization', `JWT ${token}`)
const SECRET = 'test-secret-key-at-least-16-chars'

describe('token shape', () => {
    it('a token without an expiry is refused (it would never expire)', async () => {
        const token = jwt.sign({ data: { id: ID } }, SECRET, { algorithm: 'HS256' })

        assert.equal(jwt.decode(token).exp, undefined)
        assert.equal((await me(token)).status, 401)
    })

    it('a token without an issue time is refused (it cannot be compared with a password change)', async () => {
        const token = jwt.sign({ data: { id: ID }, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET, { algorithm: 'HS256', noTimestamp: true })

        assert.equal(jwt.decode(token).iat, undefined)
        assert.equal((await me(token)).status, 401)
    })

    it('another algorithm (HS512 with the same secret) is refused', async () => {
        const token = jwt.sign({ data: { id: ID } }, SECRET, { algorithm: 'HS512', expiresIn: '1h' })

        assert.equal((await me(token)).status, 401)
    })

    it('the 401 says nothing about why', async () => {
        const res = await me(jwt.sign({ data: { id: ID } }, SECRET))

        assert.deepEqual(res.body, { message: 'Invalid or expired token' })
    })
})
