// Persists the payment time of legacy successful transactions (created before the
// time-bounded subscription model, so they have no `paidAt`).
//
//   npm run backfill:paid-at -- --dry-run   report only, writes nothing
//   npm run backfill:paid-at                apply
//
// For each successful transaction without paidAt it sets
//   paidAt        = the record's updatedAt (the best available payment time)
//   periodMonths  = 1                       (a legacy payment bought one month)
// It never creates or deletes transactions and never invents payment history.
// Idempotent: records that already have paidAt are not touched.
//
// Consequence to expect: a legacy payment older than one period is now EXPIRED.
// Nobody keeps unlimited access because of a pre-subscription payment; the
// instructor renews through POST /api/payment/checkout.
import 'dotenv/config'
import mongoose from 'mongoose'

import transactionModel from '../src/models/transactionModel.js'

const dryRun = process.argv.includes('--dry-run')

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required')
    process.exit(1)
}

await mongoose.connect(process.env.DATABASE_URL)

const legacy = await transactionModel
    .find({ status: 'success', paidAt: { $exists: false } })
    .select('user updatedAt createdAt')
    .lean()

console.log(`${legacy.length} legacy successful transaction(s) without paidAt${dryRun ? ' (dry run)' : ''}`)

let updated = 0

for (const tx of legacy) {
    const paidAt = tx.updatedAt ?? tx.createdAt

    console.log(` - ${tx._id} user ${tx.user} paidAt -> ${new Date(paidAt).toISOString()} (1 month)`)

    if (!dryRun) {
        const result = await transactionModel.collection.updateOne(
            { _id: tx._id, paidAt: { $exists: false } },
            { $set: { paidAt, periodMonths: 1, purpose: 'activation' } }
        )

        updated += result.modifiedCount
    }
}

console.log(dryRun ? 'Nothing written.' : `Updated ${updated} transaction(s).`)

await mongoose.disconnect()
