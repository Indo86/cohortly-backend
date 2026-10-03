import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addMonths, computeLatestRun, resolveAccess } from '../src/utils/subscriptionPeriod.js'

const d = (iso) => new Date(iso)
const iso = (date) => date.toISOString()

const success = (paidAt, months = 1, id = paidAt) => ({
    _id: id,
    status: 'success',
    paidAt: d(paidAt),
    createdAt: d(paidAt),
    periodMonths: months,
})

const tx = (status, createdAt, id = `${status}-${createdAt}`) => ({
    _id: id,
    status,
    createdAt: d(createdAt),
})

describe('addMonths (calendar-month semantics, UTC)', () => {
    it('keeps the day and time of day', () => {
        assert.equal(iso(addMonths(d('2026-03-15T10:20:30.400Z'), 1)), '2026-04-15T10:20:30.400Z')
    })

    it('clamps to the last day of a shorter month', () => {
        assert.equal(iso(addMonths(d('2026-01-31T12:00:00Z'), 1)), '2026-02-28T12:00:00.000Z')
        assert.equal(iso(addMonths(d('2026-03-31T12:00:00Z'), 1)), '2026-04-30T12:00:00.000Z')
    })

    it('handles leap years', () => {
        assert.equal(iso(addMonths(d('2028-01-31T00:00:00Z'), 1)), '2028-02-29T00:00:00.000Z')
        assert.equal(iso(addMonths(d('2028-02-29T00:00:00Z'), 12)), '2029-02-28T00:00:00.000Z')
    })

    it('rolls over the year', () => {
        assert.equal(iso(addMonths(d('2026-12-15T00:00:00Z'), 1)), '2027-01-15T00:00:00.000Z')
        assert.equal(iso(addMonths(d('2026-11-30T00:00:00Z'), 3)), '2027-02-28T00:00:00.000Z')
    })

    it('is not 30-day arithmetic', () => {
        const start = d('2026-01-01T00:00:00Z')

        assert.equal(iso(addMonths(start, 1)), '2026-02-01T00:00:00.000Z') // 31 days
        assert.equal(iso(addMonths(d('2026-02-01T00:00:00Z'), 1)), '2026-03-01T00:00:00.000Z') // 28 days
    })
})

describe('computeLatestRun', () => {
    it('is null when nothing was ever paid', () => {
        assert.equal(computeLatestRun([]), null)
    })

    it('first payment: starts at payment time and lasts one calendar month', () => {
        const run = computeLatestRun([success('2026-05-10T08:00:00Z')])

        assert.equal(iso(run.start), '2026-05-10T08:00:00.000Z')
        assert.equal(iso(run.end), '2026-06-10T08:00:00.000Z')
    })

    it('early renewal extends from the current expiry and keeps the run start', () => {
        const run = computeLatestRun([success('2026-05-10T08:00:00Z'), success('2026-05-25T08:00:00Z')])

        assert.equal(iso(run.start), '2026-05-10T08:00:00.000Z')
        assert.equal(iso(run.end), '2026-07-10T08:00:00.000Z')
    })

    it('renewal after expiry starts at the payment time', () => {
        const run = computeLatestRun([success('2026-01-10T08:00:00Z'), success('2026-05-25T09:30:00Z')])

        assert.equal(iso(run.start), '2026-05-25T09:30:00.000Z')
        assert.equal(iso(run.end), '2026-06-25T09:30:00.000Z')
    })

    it('stacks several early renewals without losing any paid time', () => {
        const run = computeLatestRun([
            success('2026-05-10T00:00:00Z'),
            success('2026-05-11T00:00:00Z'),
            success('2026-05-12T00:00:00Z'),
        ])

        assert.equal(iso(run.end), '2026-08-10T00:00:00.000Z')
    })

    it('does not depend on the order the records are supplied in', () => {
        const a = success('2026-05-10T00:00:00Z')
        const b = success('2026-05-20T00:00:00Z')

        assert.deepEqual(computeLatestRun([a, b]), computeLatestRun([b, a]))
    })

    it('uses each payment own period length', () => {
        const run = computeLatestRun([success('2026-05-10T00:00:00Z', 3)])

        assert.equal(iso(run.end), '2026-08-10T00:00:00.000Z')
    })

    it('treats a legacy payment without paidAt as one period from its last write', () => {
        const legacy = { _id: 'l', status: 'success', updatedAt: d('2026-05-10T00:00:00Z'), createdAt: d('2026-05-09T00:00:00Z') }

        const run = computeLatestRun([legacy])

        assert.equal(iso(run.start), '2026-05-10T00:00:00.000Z')
        assert.equal(iso(run.end), '2026-06-10T00:00:00.000Z')
    })
})

describe('resolveAccess', () => {
    const now = d('2026-05-20T00:00:00Z')

    it('NONE: no transactions', () => {
        assert.deepEqual(resolveAccess([], now), { accessStatus: 'NONE', accessStartsAt: null, accessExpiresAt: null })
    })

    it('PENDING: the latest payment is still open', () => {
        assert.equal(resolveAccess([tx('pending', '2026-05-19T00:00:00Z')], now).accessStatus, 'PENDING')
    })

    it('FAILED: the latest payment failed and nothing is paid', () => {
        assert.equal(resolveAccess([tx('failed', '2026-05-19T00:00:00Z')], now).accessStatus, 'FAILED')
    })

    it('ACTIVE: a paid period covers now', () => {
        const result = resolveAccess([success('2026-05-10T00:00:00Z')], now)

        assert.equal(result.accessStatus, 'ACTIVE')
        assert.equal(iso(result.accessStartsAt), '2026-05-10T00:00:00.000Z')
        assert.equal(iso(result.accessExpiresAt), '2026-06-10T00:00:00.000Z')
    })

    it('is ACTIVE one millisecond before the end and EXPIRED exactly at the end', () => {
        const paid = [success('2026-05-10T00:00:00Z')]

        assert.equal(resolveAccess(paid, d('2026-06-09T23:59:59.999Z')).accessStatus, 'ACTIVE')
        assert.equal(resolveAccess(paid, d('2026-06-10T00:00:00.000Z')).accessStatus, 'EXPIRED')
    })

    it('EXPIRED: the paid period ended and nothing newer exists; dates stay available', () => {
        const result = resolveAccess([success('2026-01-10T00:00:00Z')], now)

        assert.equal(result.accessStatus, 'EXPIRED')
        assert.equal(iso(result.accessExpiresAt), '2026-02-10T00:00:00.000Z')
    })

    it('a pending renewal never changes ACTIVE access', () => {
        const result = resolveAccess([success('2026-05-10T00:00:00Z'), tx('pending', '2026-05-19T00:00:00Z')], now)

        assert.equal(result.accessStatus, 'ACTIVE')
        assert.equal(iso(result.accessExpiresAt), '2026-06-10T00:00:00.000Z')
    })

    it('a failed renewal never shortens or ends ACTIVE access', () => {
        const result = resolveAccess([success('2026-05-10T00:00:00Z'), tx('failed', '2026-05-19T00:00:00Z')], now)

        assert.equal(result.accessStatus, 'ACTIVE')
        assert.equal(iso(result.accessExpiresAt), '2026-06-10T00:00:00.000Z')
    })

    it('expired + failed renewal is FAILED; expired + pending renewal is PENDING', () => {
        const base = success('2026-01-10T00:00:00Z')

        assert.equal(resolveAccess([base, tx('failed', '2026-05-19T00:00:00Z')], now).accessStatus, 'FAILED')
        assert.equal(resolveAccess([base, tx('pending', '2026-05-19T00:00:00Z')], now).accessStatus, 'PENDING')
    })
})
