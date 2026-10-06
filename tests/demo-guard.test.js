import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { demoTargetProblem } from '../scripts/demo/guard.js'

// Where `npm run seed:demo` may run (scripts/demo/guard.js). No database needed.
describe('demo seed target guard', () => {
    it('accepts a local database', () => {
        for (const url of [
            'mongodb://127.0.0.1:27017/lms',
            'mongodb://localhost:27017/cohortly_demo',
            'mongodb://user:secret@localhost/lms?authSource=admin',
            'mongodb://[::1]:27017/lms',
        ]) {
            assert.equal(demoTargetProblem(url, {}), null, url)
        }
    })

    it('refuses production: NODE_ENV or a database name that looks like production', () => {
        assert.match(demoTargetProblem('mongodb://localhost/lms', { NODE_ENV: 'production' }), /production/)
        assert.match(demoTargetProblem('mongodb://localhost/lms_prod', {}), /production/)
        assert.match(demoTargetProblem('mongodb://localhost/Production', {}), /production/)
        assert.match(demoTargetProblem('mongodb+srv://u:p@cluster0.example.mongodb.net/cohortly-prod', { DEMO_SEED_ALLOW_REMOTE: 'true' }), /production/)
    })

    it('refuses a remote database unless a dedicated demo database is explicitly allowed', () => {
        const atlas = 'mongodb+srv://u:p@cluster0.example.mongodb.net/cohortly_demo'

        assert.match(demoTargetProblem(atlas, {}), /not local/)
        assert.match(demoTargetProblem('mongodb://localhost:27017,db2.example.com:27017/lms', {}), /not local/)
        assert.equal(demoTargetProblem(atlas, { DEMO_SEED_ALLOW_REMOTE: 'true' }), null)
    })

    it('refuses a missing or malformed connection string', () => {
        assert.match(demoTargetProblem(undefined, {}), /missing/)
        assert.match(demoTargetProblem('postgres://localhost/lms', {}), /not a MongoDB/)
    })

    it('never echoes credentials in its reasons', () => {
        const reason = demoTargetProblem('mongodb+srv://admin:Sup3rSecret@cluster0.example.mongodb.net/cohortly_demo', {})

        assert.equal(reason.includes('Sup3rSecret'), false)
    })
})
