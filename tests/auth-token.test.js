import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'

process.env.SECRET_KEY_JWT ??= 'test-secret-key-at-least-16-chars'

const { credentialStamp, matchesCurrentCredentials, signSessionToken } = await import('../src/utils/authToken.js')

// The session token and the credential check (utils/authToken.js), without a database.
const ID = '64b64b64b64b64b64b64b64b'

describe('session tokens', () => {
    it('are HS256, expire after one day and carry only the account id and the credential stamp', () => {
        const changedAt = new Date('2026-10-01T10:00:00.123Z')
        const token = signSessionToken({ _id: ID, passwordChangedAt: changedAt, password: 'hash', email: 'a@b.co', role: 'manager' })
        const decoded = jwt.verify(token, process.env.SECRET_KEY_JWT, { algorithms: ['HS256'] })

        assert.equal(jwt.decode(token, { complete: true }).header.alg, 'HS256')
        assert.equal(decoded.exp - decoded.iat, 24 * 60 * 60)
        assert.deepEqual(decoded.data, { id: ID, pwdAt: changedAt.getTime() })
    })

    it('carry pwdAt null for an account whose password was never changed', () => {
        const token = signSessionToken({ _id: ID })

        assert.equal(jwt.decode(token).data.pwdAt, null)
        assert.equal(credentialStamp({}), null)
    })
})

describe('matchesCurrentCredentials', () => {
    const changedAt = new Date('2026-10-01T10:00:00.123Z')
    const decodedFor = (pwdAt) => ({ data: { id: ID, pwdAt } })

    it('accepts any token while the password was never changed (older tokens keep working)', () => {
        assert.equal(matchesCurrentCredentials(decodedFor(undefined), {}), true)
        assert.equal(matchesCurrentCredentials(decodedFor(null), { passwordChangedAt: null }), true)
    })

    it('accepts only a token issued against the current password', () => {
        const account = { passwordChangedAt: changedAt }

        assert.equal(matchesCurrentCredentials(decodedFor(changedAt.getTime()), account), true)
        assert.equal(matchesCurrentCredentials(decodedFor(null), account), false, 'issued before the first change')
        assert.equal(matchesCurrentCredentials(decodedFor(undefined), account), false, 'issued before the stamp existed')
        assert.equal(matchesCurrentCredentials(decodedFor(changedAt.getTime() - 1), account), false, 'an earlier change, even 1 ms')
        assert.equal(matchesCurrentCredentials(decodedFor(String(changedAt.getTime())), account), false, 'exact type')
    })

    it('a second change invalidates the tokens of the first one', () => {
        const first = new Date('2026-10-01T10:00:00.000Z')
        const second = new Date('2026-10-01T10:00:00.400Z')

        assert.equal(matchesCurrentCredentials(decodedFor(first.getTime()), { passwordChangedAt: second }), false)
    })
})
