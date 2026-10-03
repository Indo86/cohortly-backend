// Migrates the legacy flat content (Course.details[] -> CourseDetail rows) into the
// Course -> Section -> Lesson model.
//
//   npm run migrate:content -- --dry-run    report only, writes nothing
//   npm run migrate:content                 apply
//
// For every course that has legacy content:
//   - finds or creates ONE section titled "Course Content";
//   - creates one Lesson per legacy CourseDetail, keeping the legacy order (the order
//     of Course.details; rows missing from that array follow by creation time);
//   - sanitizes legacy rich text with the current policy while copying it.
// Course status: legacy courses have no status. Students could already read them, so a
// course with at least one lesson becomes `published` (students keep their access) and an
// empty one becomes `draft`. Courses that already have a status are never touched.
//
// Idempotent: each lesson stores `legacyDetailId` (unique index), so a rerun creates
// nothing that already exists. Legacy data is NEVER modified or deleted by this script:
// the `coursedetails` collection and `courses.details` stay as they are. They are unused
// by the application after this migration; once the verification line at the end reports
// 0 mismatches and you have a backup, they can be dropped manually:
//   db.coursedetails.drop();  db.courses.updateMany({}, { $unset: { details: "" } })
import 'dotenv/config'
import mongoose from 'mongoose'

import courseModel from '../src/models/courseModel.js'
import sectionModel from '../src/models/sectionModel.js'
import lessonModel from '../src/models/lessonModel.js'
import { sanitizeRichText } from '../src/utils/sanitize.js'

const SECTION_TITLE = 'Course Content'
const dryRun = process.argv.includes('--dry-run')

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required')
    process.exit(1)
}

await mongoose.connect(process.env.DATABASE_URL)
await Promise.all([sectionModel.init(), lessonModel.init()])

const rawCourses = mongoose.connection.collection('courses')
const rawDetails = mongoose.connection.collection('coursedetails')

const totals = {
    courses: 0,
    coursesWithLegacyContent: 0,
    sectionsCreated: 0,
    lessonsCreated: 0,
    lessonsAlreadyMigrated: 0,
    invalidSkipped: 0,
    publishedSet: 0,
    draftSet: 0,
    mismatches: 0,
}

console.log(`Course content migration${dryRun ? ' (dry run)' : ''}`)

for (const course of await rawCourses.find({}).toArray()) {
    totals.courses += 1

    const details = await rawDetails.find({ course: course._id }).toArray()
    const byId = new Map(details.map((detail) => [String(detail._id), detail]))
    const listed = (course.details ?? []).map(String).filter((id) => byId.has(id))
    const unlisted = details
        .filter((detail) => !listed.includes(String(detail._id)))
        .sort((a, b) => new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0))
    const ordered = [...listed.map((id) => byId.get(id)), ...unlisted]

    let section = await sectionModel.findOne({ course: course._id, title: SECTION_TITLE })
    let created = 0
    let existing = 0

    if (ordered.length > 0) {
        totals.coursesWithLegacyContent += 1

        if (!section) {
            totals.sectionsCreated += 1

            if (!dryRun) {
                const last = await sectionModel.findOne({ course: course._id }).sort({ order: -1 }).lean()

                section = await sectionModel.create({
                    course: course._id,
                    title: SECTION_TITLE,
                    order: last ? last.order + 1 : 0,
                })
            }
        }

        for (const [index, detail] of ordered.entries()) {
            if (await lessonModel.exists({ legacyDetailId: detail._id })) {
                existing += 1
                continue
            }

            if (!detail.title || !['video', 'text'].includes(detail.type)) {
                totals.invalidSkipped += 1
                console.log(` ! skipped invalid legacy content ${detail._id} (course ${course._id})`)
                continue
            }

            created += 1

            if (!dryRun) {
                await lessonModel.create({
                    course: course._id,
                    section: section._id,
                    title: detail.title,
                    type: detail.type,
                    text: detail.type === 'text' ? sanitizeRichText(detail.text ?? '') : undefined,
                    youtubeId: detail.type === 'video' ? detail.youtubeId : undefined,
                    order: index,
                    legacyDetailId: detail._id,
                })
            }
        }
    }

    totals.lessonsCreated += created
    totals.lessonsAlreadyMigrated += existing

    // verification: every migratable legacy row has exactly one lesson (after a real run)
    if (!dryRun) {
        const migratable = ordered.filter((d) => d.title && ['video', 'text'].includes(d.type)).length
        const lessons = await lessonModel.countDocuments({
            legacyDetailId: { $in: ordered.map((d) => d._id) },
        })

        if (lessons !== migratable) totals.mismatches += 1
    }

    if (course.status === undefined) {
        const lessonCount = dryRun
            ? existing + created
            : await lessonModel.countDocuments({ course: course._id })
        const status = lessonCount > 0 ? 'published' : 'draft'

        totals[status === 'published' ? 'publishedSet' : 'draftSet'] += 1

        if (!dryRun) {
            await courseModel.collection.updateOne(
                { _id: course._id, status: { $exists: false } },
                { $set: { status } }
            )
        }
    }

    if (ordered.length > 0 || course.status === undefined) {
        console.log(
            ` - course ${course._id}: ${ordered.length} legacy item(s), ${created} to create/created, ${existing} already migrated`
        )
    }
}

console.log(
    `${dryRun ? 'Would create' : 'Created'}: ${totals.sectionsCreated} section(s), ${totals.lessonsCreated} lesson(s). ` +
        `Already migrated: ${totals.lessonsAlreadyMigrated}. Skipped invalid: ${totals.invalidSkipped}. ` +
        `Status set: ${totals.publishedSet} published, ${totals.draftSet} draft. ` +
        `Courses scanned: ${totals.courses} (${totals.coursesWithLegacyContent} with legacy content).`
)
console.log(
    dryRun
        ? 'Nothing written.'
        : `Verification: ${totals.mismatches} mismatch(es). Legacy data was left untouched.`
)

await mongoose.disconnect()
process.exitCode = totals.mismatches > 0 ? 1 : 0
