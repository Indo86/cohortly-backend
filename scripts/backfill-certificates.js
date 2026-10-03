// Issues certificates for students who ALREADY meet the course-completion rule and have none.
//
//   npm run backfill:certificates -- --dry-run   report only, writes nothing
//   npm run backfill:certificates                apply
//
// Why it exists: certificates are issued when a student completes a course, but courses completed
// before certificates existed have nothing to trigger the issuance. This is run on purpose, never
// automatically at startup.
//
// Rules
//  - Only CURRENTLY qualifying enrollments: every lesson completed, plus a passed final quiz when
//    the course has one (the same single rule the API uses, utils/progress.js).
//  - Idempotent: a student who already has a certificate for the course is skipped, and the unique
//    (student, course) index makes a duplicate impossible even if two runs overlap.
//  - issuedAt = the moment the last requirement was met: the later of the student's most recent
//    lesson completion and their first passing quiz attempt.
//
// Limitations (read before applying)
//  - Lesson progress only reflects the present: a lesson that was undone and completed again moves
//    the date, and nothing records when a course was "first" completed. The date is a defensible
//    reconstruction, not a historical fact.
//  - Draft courses are included (a student may have completed it while it was published).
import 'dotenv/config'
import mongoose from 'mongoose'

import certificateModel from '../src/models/certificateModel.js'
import { backfillCertificates } from '../src/services/certificates.js'

const dryRun = process.argv.includes('--dry-run')

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required')
    process.exit(1)
}

await mongoose.connect(process.env.DATABASE_URL)
await certificateModel.init() // build the unique indexes before the first insert

console.log(`Certificate backfill${dryRun ? ' (dry run)' : ''}`)

const report = await backfillCertificates({ dryRun, log: console.log })

console.log('')
console.log(`Courses scanned:        ${report.courses}`)
console.log(`Enrollments scanned:    ${report.students}`)
console.log(`Already certified:      ${report.alreadyCertified}`)
console.log(`Qualify but have none:  ${report.eligible}`)
console.log(dryRun ? 'Nothing written (dry run).' : `Certificates issued:    ${report.issued}`)

await mongoose.disconnect()
