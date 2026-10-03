import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
    auth, createCategory, createCourse, createInstructor, createStudent, enroll, models, mongoUri, mongoose,
    resetDb, startTestEnv, stopTestEnv,
} from './helpers.js'

let request

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(async () => {
    await resetDb()
    await mongoose.connection.collection('coursedetails').deleteMany({})
})

const root = path.resolve(import.meta.dirname, '..')
const migrate = (...args) =>
    execFileSync(process.execPath, ['scripts/migrate-course-content.js', ...args], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: mongoUri() },
        encoding: 'utf8',
    })

const details = () => mongoose.connection.collection('coursedetails')
const rawCourses = () => mongoose.connection.collection('courses')
const oid = () => new mongoose.Types.ObjectId()
const ids = (rows) => rows.map((row) => String(row._id))

// Builds a course the way the legacy (pre-M3B) application stored it: flat CourseDetail
// rows referenced by Course.details, and no status field.
const legacyCourse = async (instructor, category, items) => {
    const _id = oid()
    const rows = items.map((item, index) => ({
        _id: oid(),
        course: _id,
        createdAt: new Date(2026, 0, 1, 0, index),
        updatedAt: new Date(2026, 0, 1, 0, index),
        ...item,
    }))

    if (rows.length) await details().insertMany(rows)

    await rawCourses().insertOne({
        _id,
        name: 'Legacy course',
        thumbnail: 'thumb.png',
        tagline: 'tagline',
        description: 'legacy description',
        category: category._id,
        manager: instructor._id,
        students: [],
        details: rows.map((row) => row._id),
    })

    return { _id, rows }
}

const legacyItems = () => [
    { title: 'Installing the tools', type: 'video', youtubeId: 'dQw4w9WgXcQ' },
    { title: 'Reading material', type: 'text', text: '<p>safe</p><script>alert(1)</script>' },
    { title: 'Last lesson here', type: 'video', youtubeId: 'abcdefghijk' },
]

describe('legacy content migration (npm run migrate:content)', () => {
    it('--dry-run reports what it would do and changes nothing', async () => {
        const instructor = await createInstructor()
        const category = await createCategory()
        const legacy = await legacyCourse(instructor, category, legacyItems())

        const output = migrate('--dry-run')

        assert.match(output, /dry run/)
        assert.match(output, /Would create: 1 section\(s\), 3 lesson\(s\)/)
        assert.match(output, /Nothing written/)
        assert.equal(await models.sectionModel.countDocuments(), 0)
        assert.equal(await models.lessonModel.countDocuments(), 0)
        assert.equal((await rawCourses().findOne({ _id: legacy._id })).status, undefined)
    })

    it('moves flat content into one default section, preserving the original order', async () => {
        const instructor = await createInstructor()
        const category = await createCategory()
        const legacy = await legacyCourse(instructor, category, legacyItems())

        const output = migrate()

        assert.match(output, /Created: 1 section\(s\), 3 lesson\(s\)/)
        assert.match(output, /Verification: 0 mismatch/)

        const sections = await models.sectionModel.find({ course: legacy._id })
        assert.equal(sections.length, 1)
        assert.equal(sections[0].title, 'Course Content')

        const lessons = await models.lessonModel.find({ course: legacy._id }).sort({ order: 1 })
        assert.deepEqual(lessons.map((l) => l.title), ['Installing the tools', 'Reading material', 'Last lesson here'])
        assert.deepEqual(lessons.map((l) => l.order), [0, 1, 2])
        assert.deepEqual(lessons.map((l) => String(l.legacyDetailId)), ids(legacy.rows))
        assert.ok(lessons.every((l) => String(l.section) === String(sections[0]._id)))
        assert.equal(lessons[0].youtubeId, 'dQw4w9WgXcQ')
        assert.equal(lessons[1].text, '<p>safe</p>', 'legacy rich text is sanitized on the way in')
    })

    it('keeps the order of Course.details even when the rows were created in a different order', async () => {
        const instructor = await createInstructor()
        const category = await createCategory()
        const legacy = await legacyCourse(instructor, category, legacyItems())
        const reversed = [...legacy.rows].reverse().map((row) => row._id)
        await rawCourses().updateOne({ _id: legacy._id }, { $set: { details: reversed } })

        migrate()

        const lessons = await models.lessonModel.find({ course: legacy._id }).sort({ order: 1 })
        assert.deepEqual(lessons.map((l) => String(l.legacyDetailId)), reversed.map(String))
    })

    it('is idempotent: a second run creates nothing and duplicates nothing', async () => {
        const instructor = await createInstructor()
        const category = await createCategory()
        await legacyCourse(instructor, category, legacyItems())

        migrate()
        const sectionsAfterFirst = await models.sectionModel.countDocuments()
        const lessonsAfterFirst = await models.lessonModel.countDocuments()

        const second = migrate()

        assert.match(second, /Created: 0 section\(s\), 0 lesson\(s\)\. Already migrated: 3/)
        assert.equal(await models.sectionModel.countDocuments(), sectionsAfterFirst)
        assert.equal(await models.lessonModel.countDocuments(), lessonsAfterFirst)
    })

    it('never deletes or changes the legacy data', async () => {
        const instructor = await createInstructor()
        const category = await createCategory()
        const legacy = await legacyCourse(instructor, category, legacyItems())
        const before = await details().find({}).toArray()

        migrate()

        assert.deepEqual(await details().find({}).toArray(), before)
        assert.equal((await rawCourses().findOne({ _id: legacy._id })).details.length, 3)
    })

    it('publishes a legacy course that has content (students keep access) and drafts an empty one', async () => {
        const instructor = await createInstructor()
        const category = await createCategory()
        const withContent = await legacyCourse(instructor, category, legacyItems())
        const empty = await legacyCourse(instructor, category, [])

        const output = migrate()

        assert.match(output, /Status set: 1 published, 1 draft/)
        assert.equal((await rawCourses().findOne({ _id: withContent._id })).status, 'published')
        assert.equal((await rawCourses().findOne({ _id: empty._id })).status, 'draft')
    })

    it('does not touch the status of courses that already have one', async () => {
        const instructor = await createInstructor()
        const category = await createCategory()
        const draft = await createCourse(instructor, category) // created by the new model: draft

        migrate()

        assert.equal((await rawCourses().findOne({ _id: draft._id })).status, 'draft')
    })

    it('an enrolled student can learn from migrated content after the migration', async () => {
        const instructor = await createInstructor()
        const category = await createCategory()
        const student = await createStudent(instructor)
        const legacy = await legacyCourse(instructor, category, legacyItems())
        await rawCourses().updateOne({ _id: legacy._id }, { $set: { students: [student._id] } })
        await models.userModel.updateOne({ _id: student._id }, { $push: { courses: legacy._id } })

        migrate()

        const view = await request.get(`/api/students-courses/${legacy._id}`).set(auth(student))
        assert.equal(view.status, 200)
        assert.deepEqual(view.body.data.progress, { completedLessons: 0, totalLessons: 3, percent: 0, completed: false })
        assert.equal(view.body.data.nextLesson.title, 'Installing the tools')

        const instructorView = await request.get(`/api/courses/${legacy._id}`).set(auth(instructor))
        assert.equal(instructorView.body.data.sections[0].lessons.length, 3)
    })

    it('skips (and reports) invalid legacy rows instead of inventing content', async () => {
        const instructor = await createInstructor()
        const category = await createCategory()
        const legacy = await legacyCourse(instructor, category, [
            ...legacyItems().slice(0, 1),
            { title: '', type: 'text', text: '<p>no title</p>' },
            { title: 'Unknown type here', type: 'audio' },
        ])

        const output = migrate()

        assert.match(output, /Skipped invalid: 2/)
        assert.equal(await models.lessonModel.countDocuments({ course: legacy._id }), 1)
    })

    it('adds new content after migration without disturbing the migrated order', async () => {
        const instructor = await createInstructor()
        const category = await createCategory()
        const legacy = await legacyCourse(instructor, category, legacyItems())
        migrate()
        const section = await models.sectionModel.findOne({ course: legacy._id })

        const created = await request
            .post(`/api/sections/${section._id}/lessons`)
            .set(auth(instructor))
            .send({ title: 'Added later', type: 'text', text: '<p>later</p>' })

        assert.equal(created.body.data.order, 3, 'appended after the migrated lessons')
        assert.match(migrate(), /Created: 0 section\(s\), 0 lesson\(s\)/)
    })
})
