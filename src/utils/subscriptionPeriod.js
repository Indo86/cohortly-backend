// Pure subscription arithmetic (no database, no clock of its own).
//
// Model: every successful payment ("grant") buys `periodMonths` calendar months.
// Grants are replayed in the order they were paid:
//   - a grant paid while access is still running starts when the current period
//     ends (it extends, never shortens);
//   - a grant paid after access ended starts at the moment of payment.
// Consecutive periods form one "run". The current run answers: when did access
// start, when does it end, is it active.
//
// Calendar-month semantics: the same day-of-month and time of day in the target
// month (UTC), clamped to the last day of shorter months (31 Jan + 1 month =
// 28/29 Feb). Chained renewals add months to the previous expiry, so a clamped
// date stays clamped (31 Jan -> 28 Feb -> 28 Mar). 30-day periods are never used.
import { ACCESS } from './accessStatus.js'

const LEGACY_PERIOD_MONTHS = 1

export const addMonths = (date, months) => {
    const source = new Date(date)
    const targetMonthIndex = source.getUTCMonth() + months
    const year = source.getUTCFullYear() + Math.floor(targetMonthIndex / 12)
    const month = ((targetMonthIndex % 12) + 12) % 12
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

    return new Date(
        Date.UTC(
            year,
            month,
            Math.min(source.getUTCDate(), lastDay),
            source.getUTCHours(),
            source.getUTCMinutes(),
            source.getUTCSeconds(),
            source.getUTCMilliseconds()
        )
    )
}

// Legacy (pre-M3A) successful transactions have no paidAt. The best available
// estimate is the last time the record was written. This never grants more than
// one period; see scripts/backfill-paid-at.js to persist it.
const paidAtOf = (tx) => tx.paidAt ?? tx.updatedAt ?? tx.createdAt

const byPaidAt = (a, b) => {
    const diff = new Date(paidAtOf(a)) - new Date(paidAtOf(b))

    return diff !== 0 ? diff : String(a._id).localeCompare(String(b._id))
}

// Returns the most recent contiguous run of paid time, or null if never paid.
export const computeLatestRun = (successfulTransactions) => {
    let run = null

    for (const tx of [...successfulTransactions].sort(byPaidAt)) {
        const paidAt = new Date(paidAtOf(tx))
        const months = tx.periodMonths ?? LEGACY_PERIOD_MONTHS

        if (run && paidAt < run.end) {
            run = { start: run.start, end: addMonths(run.end, months) }
        } else {
            run = { start: paidAt, end: addMonths(paidAt, months) }
        }
    }

    return run
}

// Resolves the access state of one workspace from its transactions at `now`.
//   ACTIVE   a paid period covers `now`
//   otherwise the latest transaction decides:
//   PENDING  waiting for payment
//   FAILED   the latest payment failed
//   EXPIRED  the latest payment succeeded but its period has ended
//   NONE     no transactions at all
// An unfinished or failed renewal can never reduce an ACTIVE period, because
// ACTIVE is decided first and only from successful payments.
export const resolveAccess = (transactions, now = new Date()) => {
    const run = computeLatestRun(transactions.filter((tx) => tx.status === 'success'))

    const dates = {
        accessStartsAt: run ? run.start : null,
        accessExpiresAt: run ? run.end : null,
    }

    if (run && run.start <= now && now < run.end) {
        return { accessStatus: ACCESS.ACTIVE, ...dates }
    }

    const latest = [...transactions].sort(
        (a, b) =>
            new Date(b.createdAt) - new Date(a.createdAt) ||
            String(b._id).localeCompare(String(a._id))
    )[0]

    if (!latest) return { accessStatus: ACCESS.NONE, ...dates }

    if (latest.status === 'pending') return { accessStatus: ACCESS.PENDING, ...dates }
    if (latest.status === 'failed') return { accessStatus: ACCESS.FAILED, ...dates }

    return { accessStatus: ACCESS.EXPIRED, ...dates }
}
