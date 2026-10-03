// Read-only report of users sharing an email (case-insensitive). Deletes nothing.
//   npm run check:emails
// The unique email index cannot be built while duplicates exist; resolve them
// manually (e.g. rename or remove the unwanted account) and restart the server.
import 'dotenv/config'
import mongoose from 'mongoose'

import userModel from '../src/models/userModel.js'

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required')
    process.exit(1)
}

await mongoose.connect(process.env.DATABASE_URL)

const duplicates = await userModel.aggregate([
    { $group: { _id: { $toLower: '$email' }, count: { $sum: 1 }, ids: { $push: '$_id' }, roles: { $push: '$role' } } },
    { $match: { count: { $gt: 1 } } },
])

if (duplicates.length === 0) {
    console.log('No duplicate emails found.')
} else {
    console.log(`${duplicates.length} duplicate email(s):`)
    for (const entry of duplicates) {
        console.log(` - ${entry._id}: ${entry.count} accounts [${entry.roles.join(', ')}] ids ${entry.ids.join(', ')}`)
    }
}

const mixedCase = await userModel.countDocuments({ email: { $regex: /[A-Z]/ } })

if (mixedCase > 0) {
    console.log(`${mixedCase} account(s) have upper-case characters in their email. Emails are now matched in lower case, so these users cannot sign in until the stored value is lower-cased.`)
}

await mongoose.disconnect()
process.exitCode = duplicates.length > 0 ? 1 : 0
