import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    PNG, auth, complete, createCategory, createCourse, createInstructor, createLesson, createSection, createStudent, enroll,
    models, pay, resetDb, startTestEnv, stopTestEnv, daysAgo,
} from './helpers.js'

let request
let instructor
let category
let headers

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(async () => {
    await resetDb()
    instructor = await createInstructor()
    category = await createCategory()
    headers = auth(instructor)
})

const textBody = (title = 'A text lesson', text = '<p>hello there</p>') => ({ title, type: 'text', text })
const ids = (rows) => rows.map((row) => String(row._id))

describe('course create / detail contract (M5)', () => {
    it('creating a course returns its id, and the course starts as a draft', async () => {
        const res = await request
            .post('/api/courses')
            .set(headers)
            .field('name', 'Course with an id')
            .field('tagline', 'A tagline')
            .field('description', 'A long enough description')
            .field('categoryId', category._id.toString())
            .attach('thumbnail', PNG, { filename: 'a.png', contentType: 'image/png' })

        assert.equal(res.status, 200)
        assert.match(res.body.data._id, /^[0-9a-f]{24}$/)

        const stored = await models.courseModel.findById(res.body.data._id)
        assert.equal(stored.name, 'Course with an id')
        assert.equal(stored.status, 'draft')
    })

    it('the course detail returns the category id as well as its name, so an edit form can pre-select it', async () => {
        const course = await createCourse(instructor, category)

        const res = await request.get(`/api/courses/${course._id}`).set(headers)

        assert.equal(res.status, 200)
        assert.equal(res.body.data.category._id, category._id.toString())
        assert.equal(res.body.data.category.name, 'Programming')
    })
})

describe('course status (draft / published)', () => {
    it('a course created through the API is a DRAFT, and the client cannot choose otherwise', async () => {
        const res = await request
            .post('/api/courses')
            .set(headers)
            .field('name', 'Draft by default')
            .field('tagline', 'A tagline')
            .field('description', 'A long enough description')
            .field('categoryId', category._id.toString())
            .field('status', 'published')
            .attach('thumbnail', PNG, { filename: 'a.png', contentType: 'image/png' })

        assert.equal(res.status, 200)
        assert.equal((await models.courseModel.findOne({ name: 'Draft by default' })).status, 'draft')
    })

    it('the instructor can publish a course that has a lesson, and unpublish it again', async () => {
        const course = await createCourse(instructor, category)
        await createLesson(course)

        const published = await request.put(`/api/courses/${course._id}/status`).set(headers).send({ status: 'published' })
        assert.equal(published.status, 200)
        assert.equal(published.body.data.status, 'published')

        const again = await request.put(`/api/courses/${course._id}/status`).set(headers).send({ status: 'published' })
        assert.equal(again.status, 200, 'publishing twice is idempotent')

        const draft = await request.put(`/api/courses/${course._id}/status`).set(headers).send({ status: 'draft' })
        assert.equal(draft.body.data.status, 'draft')
    })

    it('refuses to publish a course without any lesson (422) and a section alone is not enough', async () => {
        const course = await createCourse(instructor, category)

        const empty = await request.put(`/api/courses/${course._id}/status`).set(headers).send({ status: 'published' })
        assert.equal(empty.status, 422)
        assert.equal(empty.body.code, 'COURSE_NOT_PUBLISHABLE')

        await createSection(course)
        const sectionOnly = await request.put(`/api/courses/${course._id}/status`).set(headers).send({ status: 'published' })
        assert.equal(sectionOnly.status, 422)
        assert.equal((await models.courseModel.findById(course._id)).status, 'draft')
    })

    it('rejects an unknown status with 400', async () => {
        const course = await createCourse(instructor, category)

        const res = await request.put(`/api/courses/${course._id}/status`).set(headers).send({ status: 'archived' })

        assert.equal(res.status, 400)
    })

    it('students see only PUBLISHED courses they are enrolled in', async () => {
        const student = await createStudent(instructor)
        const course = await createCourse(instructor, category)
        await createLesson(course)
        await enroll(course, student)
        const studentHeaders = auth(student)

        assert.equal((await request.get('/api/students-courses').set(studentHeaders)).body.data.length, 0)
        assert.equal((await request.get(`/api/students-courses/${course._id}`).set(studentHeaders)).status, 404)

        await request.put(`/api/courses/${course._id}/status`).set(headers).send({ status: 'published' })

        assert.equal((await request.get('/api/students-courses').set(studentHeaders)).body.data.length, 1)
        assert.equal((await request.get(`/api/students-courses/${course._id}`).set(studentHeaders)).status, 200)
    })

    it('unpublishing hides the course from the student at once but keeps their progress', async () => {
        const student = await createStudent(instructor)
        const course = await createCourse(instructor, category, { published: true })
        const lessons = [await createLesson(course), await createLesson(course)]
        await enroll(course, student)
        await complete(student, lessons[0])
        const studentHeaders = auth(student)

        await request.put(`/api/courses/${course._id}/status`).set(headers).send({ status: 'draft' })

        assert.equal((await request.get('/api/students-courses').set(studentHeaders)).body.data.length, 0)
        assert.equal((await request.get(`/api/students-courses/${course._id}`).set(studentHeaders)).status, 404)
        assert.equal((await request.get(`/api/students-courses/${course._id}/lessons/${lessons[1]._id}`).set(studentHeaders)).status, 404)
        assert.equal((await request.put(`/api/lessons/${lessons[1]._id}/completion`).set(studentHeaders)).status, 404)
        assert.equal(await models.lessonProgressModel.countDocuments({ student: student._id }), 1, 'progress is kept')

        await request.put(`/api/courses/${course._id}/status`).set(headers).send({ status: 'published' })

        const back = await request.get(`/api/students-courses/${course._id}`).set(studentHeaders)
        assert.equal(back.body.data.progress.completedLessons, 1)
    })

    it('the instructor still sees and manages a draft course', async () => {
        const course = await createCourse(instructor, category)

        assert.equal((await request.get(`/api/courses/${course._id}`).set(headers)).status, 200)
        assert.equal((await request.get('/api/courses').set(headers)).body.data[0].status, 'draft')
    })

    it('editing course details never changes the status', async () => {
        const course = await createCourse(instructor, category, { published: true })

        await request
            .put(`/api/courses/${course._id}`)
            .set(headers)
            .field('name', 'Renamed course name')
            .field('tagline', 'New tagline')
            .field('description', 'New description text')
            .field('categoryId', category._id.toString())
            .field('status', 'draft')

        assert.equal((await models.courseModel.findById(course._id)).status, 'published')
    })
})

describe('sections', () => {
    let course

    beforeEach(async () => {
        course = await createCourse(instructor, category)
    })

    it('creates sections, appended to the end in order', async () => {
        const a = await request.post(`/api/courses/${course._id}/sections`).set(headers).send({ title: 'First' })
        const b = await request.post(`/api/courses/${course._id}/sections`).set(headers).send({ title: 'Second' })
        const c = await request.post(`/api/courses/${course._id}/sections`).set(headers).send({ title: 'Third' })

        assert.equal(a.status, 201)
        assert.deepEqual([a, b, c].map((r) => r.body.data.order), [0, 1, 2])

        const list = await request.get(`/api/courses/${course._id}/sections`).set(headers)
        assert.deepEqual(list.body.data.map((s) => s.title), ['First', 'Second', 'Third'])
    })

    it('validates the title', async () => {
        const res = await request.post(`/api/courses/${course._id}/sections`).set(headers).send({ title: 'x' })

        assert.equal(res.status, 400)
    })

    it('renames a section without touching its position or lessons', async () => {
        const section = await createSection(course, { title: 'Old title' })
        await createLesson(course, { section })

        const res = await request.put(`/api/sections/${section._id}`).set(headers).send({ title: 'New title' })

        assert.equal(res.status, 200)
        const stored = await models.sectionModel.findById(section._id)
        assert.equal(stored.title, 'New title')
        assert.equal(stored.order, section.order)
        assert.equal(await models.lessonModel.countDocuments({ section: section._id }), 1)
    })

    it('reorders sections with one explicit operation and returns the new outline', async () => {
        const [s1, s2, s3] = [await createSection(course, { title: 'One' }), await createSection(course, { title: 'Two' }), await createSection(course, { title: 'Three' })]

        const res = await request
            .patch(`/api/courses/${course._id}/sections/reorder`)
            .set(headers)
            .send({ sectionIds: [s3._id, s1._id, s2._id] })

        assert.equal(res.status, 200)
        assert.deepEqual(res.body.data.map((s) => s.title), ['Three', 'One', 'Two'])
        assert.deepEqual(res.body.data.map((s) => s.order), [0, 1, 2], 'positions are dense, never ambiguous')

        const stored = await models.sectionModel.find({ course: course._id }).sort({ order: 1 })
        assert.deepEqual(ids(stored), ids([s3, s1, s2]))
    })

    it('rejects reorders with missing, extra, duplicate or foreign ids and changes nothing', async () => {
        const [s1, s2] = [await createSection(course), await createSection(course)]
        const other = await createCourse(instructor, category)
        const foreign = await createSection(other)
        const send = (sectionIds) => request.patch(`/api/courses/${course._id}/sections/reorder`).set(headers).send({ sectionIds })

        assert.equal((await send([s1._id])).status, 400, 'missing')
        assert.equal((await send([s1._id, s2._id, foreign._id])).status, 400, 'extra / foreign')
        assert.equal((await send([s1._id, foreign._id])).status, 400, 'foreign instead of own')
        assert.equal((await send([s1._id, s1._id])).status, 400, 'duplicate')
        assert.equal((await send([])).status, 400, 'empty')
        assert.equal((await send(['oops'])).status, 400, 'malformed')
        assert.equal((await send([s1._id, s2._id, foreign._id])).body.code, 'REORDER_MISMATCH')

        const stored = await models.sectionModel.find({ course: course._id }).sort({ order: 1 })
        assert.deepEqual(ids(stored), ids([s1, s2]))
        assert.equal((await models.sectionModel.findById(foreign._id)).order, 0, 'the foreign section is untouched')
    })

    it('deleting a section deletes its lessons and their progress, and nothing else', async () => {
        const student = await createStudent(instructor)
        const keep = await createSection(course, { title: 'Keep' })
        const drop = await createSection(course, { title: 'Drop' })
        const keptLesson = await createLesson(course, { section: keep })
        const lessonA = await createLesson(course, { section: drop })
        const lessonB = await createLesson(course, { section: drop })
        await enroll(course, student)
        await complete(student, keptLesson)
        await complete(student, lessonA)
        await complete(student, lessonB)

        const res = await request.delete(`/api/sections/${drop._id}`).set(headers)

        assert.equal(res.status, 200)
        assert.equal(await models.sectionModel.countDocuments({ course: course._id }), 1)
        assert.deepEqual(ids(await models.lessonModel.find({ course: course._id })), ids([keptLesson]))
        assert.deepEqual(
            ids(await models.lessonProgressModel.find({ student: student._id })).length,
            1,
            'only the progress of the surviving lesson remains'
        )
        assert.equal(await models.lessonProgressModel.countDocuments({ lesson: { $in: [lessonA._id, lessonB._id] } }), 0)
    })

    it('answers 404 for unknown sections and a 400 for malformed bodies', async () => {
        assert.equal((await request.put('/api/sections/64b64b64b64b64b64b64b64b').set(headers).send({ title: 'Valid title' })).status, 404)
        assert.equal((await request.delete('/api/sections/64b64b64b64b64b64b64b64b').set(headers)).status, 404)
    })
})

describe('lessons', () => {
    let course
    let section

    beforeEach(async () => {
        course = await createCourse(instructor, category)
        section = await createSection(course)
    })

    it('creates a TEXT lesson (sanitized text, no youtube id) appended to the section', async () => {
        const res = await request
            .post(`/api/sections/${section._id}/lessons`)
            .set(headers)
            .send({ ...textBody(), youtubeId: 'ignored-id' })

        assert.equal(res.status, 201)
        assert.equal(res.body.data.type, 'text')
        assert.equal(res.body.data.order, 0)
        assert.equal(String(res.body.data.course), String(course._id), 'course is derived from the section')

        const stored = await models.lessonModel.findById(res.body.data._id)
        assert.equal(stored.youtubeId, undefined, 'the unused field is not stored')
    })

    it('creates a VIDEO lesson (youtube id, no text)', async () => {
        const res = await request
            .post(`/api/sections/${section._id}/lessons`)
            .set(headers)
            .send({ title: 'A video lesson', type: 'video', youtubeId: 'dQw4w9WgXcQ', text: '<p>ignored</p>' })

        assert.equal(res.status, 201)

        const stored = await models.lessonModel.findById(res.body.data._id)
        assert.equal(stored.youtubeId, 'dQw4w9WgXcQ')
        assert.equal(stored.text, undefined)
    })

    it('validates type, title, youtube id and text', async () => {
        const post = (body) => request.post(`/api/sections/${section._id}/lessons`).set(headers).send(body)

        assert.equal((await post({ ...textBody(), title: 'abc' })).status, 400)
        assert.equal((await post({ title: 'A lesson', type: 'quiz' })).status, 400)
        assert.equal((await post({ title: 'A video', type: 'video' })).status, 400)
        assert.equal((await post({ title: 'A video', type: 'video', youtubeId: 'a b/c' })).status, 400)
        assert.equal((await post({ title: 'A text', type: 'text', text: 'ab' })).status, 400)
        assert.equal(await models.lessonModel.countDocuments(), 0)
    })

    it('appends lessons in order and keeps lessons of different sections apart', async () => {
        const other = await createSection(course)

        const l1 = await request.post(`/api/sections/${section._id}/lessons`).set(headers).send(textBody('Lesson one'))
        const l2 = await request.post(`/api/sections/${section._id}/lessons`).set(headers).send(textBody('Lesson two'))
        const l3 = await request.post(`/api/sections/${other._id}/lessons`).set(headers).send(textBody('Lesson three'))

        assert.deepEqual([l1, l2, l3].map((r) => r.body.data.order), [0, 1, 0])
    })

    it('reads a lesson for management with its sanitized content', async () => {
        const lesson = await createLesson(course, { section, text: '<p>safe</p><script>x()</script>' })

        const res = await request.get(`/api/lessons/${lesson._id}`).set(headers)

        assert.equal(res.status, 200)
        assert.equal(res.body.data.text, '<p>safe</p>')
    })

    it('updates a lesson, can switch its type, and sanitizes the new text', async () => {
        const lesson = await createLesson(course, { section })

        const toVideo = await request
            .put(`/api/lessons/${lesson._id}`)
            .set(headers)
            .send({ title: 'Now a video', type: 'video', youtubeId: 'dQw4w9WgXcQ' })
        assert.equal(toVideo.status, 200)

        let stored = await models.lessonModel.findById(lesson._id)
        assert.equal(stored.type, 'video')
        assert.equal(stored.text, undefined, 'text is cleared when the lesson becomes a video')

        await request.put(`/api/lessons/${lesson._id}`).set(headers).send(textBody('Back to text', '<p>again</p><script>x()</script>'))
        stored = await models.lessonModel.findById(lesson._id)
        assert.equal(stored.text, '<p>again</p>')
        assert.equal(stored.youtubeId, undefined)
    })

    it('cannot move a lesson to another section or course through an update, nor change its order', async () => {
        const otherSection = await createSection(course)
        const otherCourse = await createCourse(instructor, category)
        const lesson = await createLesson(course, { section })

        const res = await request
            .put(`/api/lessons/${lesson._id}`)
            .set(headers)
            .send({ ...textBody('Moved lesson'), section: otherSection._id, sectionId: otherSection._id, course: otherCourse._id, courseId: otherCourse._id, order: 99 })

        assert.equal(res.status, 200)
        const stored = await models.lessonModel.findById(lesson._id)
        assert.equal(String(stored.section), String(section._id))
        assert.equal(String(stored.course), String(course._id))
        assert.equal(stored.order, lesson.order)
    })

    it('reorders the lessons of a section with one operation', async () => {
        const [a, b, c] = [await createLesson(course, { section }), await createLesson(course, { section }), await createLesson(course, { section })]

        const res = await request
            .patch(`/api/sections/${section._id}/lessons/reorder`)
            .set(headers)
            .send({ lessonIds: [c._id, a._id, b._id] })

        assert.equal(res.status, 200)
        assert.deepEqual(ids(res.body.data), ids([c, a, b]))
        assert.deepEqual(res.body.data.map((l) => l.order), [0, 1, 2])
    })

    it('rejects lesson reorders with missing, duplicate or foreign lessons and changes nothing', async () => {
        const other = await createSection(course)
        const [a, b] = [await createLesson(course, { section }), await createLesson(course, { section })]
        const foreign = await createLesson(course, { section: other })
        const send = (lessonIds) => request.patch(`/api/sections/${section._id}/lessons/reorder`).set(headers).send({ lessonIds })

        assert.equal((await send([a._id])).status, 400)
        assert.equal((await send([a._id, a._id])).status, 400)
        assert.equal((await send([a._id, b._id, foreign._id])).status, 400, 'a lesson of another section')
        assert.equal((await send([a._id, foreign._id])).status, 400)

        const stored = await models.lessonModel.find({ section: section._id }).sort({ order: 1 })
        assert.deepEqual(ids(stored), ids([a, b]))
        assert.equal((await models.lessonModel.findById(foreign._id)).order, foreign.order)
    })

    it('deleting a lesson removes it and every student completion of it', async () => {
        const [s1, s2] = [await createStudent(instructor), await createStudent(instructor)]
        const gone = await createLesson(course, { section })
        const kept = await createLesson(course, { section })
        await enroll(course, s1)
        await enroll(course, s2)
        await complete(s1, gone)
        await complete(s2, gone)
        await complete(s1, kept)

        const res = await request.delete(`/api/lessons/${gone._id}`).set(headers)

        assert.equal(res.status, 200)
        assert.equal(await models.lessonModel.countDocuments({ _id: gone._id }), 0)
        assert.equal(await models.lessonProgressModel.countDocuments({ lesson: gone._id }), 0)
        assert.equal(await models.lessonProgressModel.countDocuments({ lesson: kept._id }), 1)
    })

    it('deleting a course deletes its sections, lessons and all learning records', async () => {
        const student = await createStudent(instructor)
        const lesson = await createLesson(course, { section })
        await enroll(course, student)
        await complete(student, lesson)

        const otherCourse = await createCourse(instructor, category)
        const otherLesson = await createLesson(otherCourse)
        await enroll(otherCourse, student)
        await complete(student, otherLesson)

        const res = await request.delete(`/api/courses/${course._id}`).set(headers)

        assert.equal(res.status, 200)
        assert.equal(await models.sectionModel.countDocuments({ course: course._id }), 0)
        assert.equal(await models.lessonModel.countDocuments({ course: course._id }), 0)
        assert.equal(await models.lessonProgressModel.countDocuments({ course: course._id }), 0)
        assert.equal(await models.lessonProgressModel.countDocuments({ course: otherCourse._id }), 1, 'other courses are untouched')
        assert.deepEqual(ids((await models.userModel.findById(student._id)).courses.map((id) => ({ _id: id }))), ids([otherCourse]))
    })

    it('shows the ordered outline in the course management view; content only with preview=true', async () => {
        const s2 = await createSection(course, { title: 'Second' })
        const l1 = await createLesson(course, { section, text: '<p>one</p>' })
        await createLesson(course, { section: s2, text: '<p>two</p>' })

        const plain = await request.get(`/api/courses/${course._id}`).set(headers)
        const preview = await request.get(`/api/courses/${course._id}?preview=true`).set(headers)

        assert.deepEqual(plain.body.data.sections.map((s) => s.title), ['Section title', 'Second'])
        assert.equal(plain.body.data.sections[0].lessons[0].text, undefined)
        assert.equal(preview.body.data.sections[0].lessons[0].text, '<p>one</p>')
        assert.equal(plain.body.data.total_lessons, 2)
        assert.equal(String(plain.body.data.sections[0].lessons[0]._id), String(l1._id))
        assert.equal(plain.body.data.details, undefined, 'the legacy details array is gone')
    })
})

describe('hard entitlement on the new instructor endpoints', () => {
    for (const state of ['NONE', 'PENDING', 'FAILED', 'EXPIRED']) {
        it(`blocks section, lesson, status and progress management when ${state}`, async () => {
            const owner = await createInstructor({ active: true })
            const course = await createCourse(owner, category)
            const section = await createSection(course)
            const lesson = await createLesson(course, { section })
            await models.transactionModel.deleteMany({ user: owner._id })
            if (state === 'PENDING') await pay(owner, { status: 'pending' })
            if (state === 'FAILED') await pay(owner, { status: 'failed' })
            if (state === 'EXPIRED') await pay(owner, { paidAt: daysAgo(45) })
            const h = auth(owner)
            const body = textBody()

            const calls = [
                () => request.get(`/api/courses/${course._id}/sections`).set(h),
                () => request.post(`/api/courses/${course._id}/sections`).set(h).send({ title: 'New section' }),
                () => request.patch(`/api/courses/${course._id}/sections/reorder`).set(h).send({ sectionIds: [section._id] }),
                () => request.put(`/api/sections/${section._id}`).set(h).send({ title: 'Renamed' }),
                () => request.delete(`/api/sections/${section._id}`).set(h),
                () => request.post(`/api/sections/${section._id}/lessons`).set(h).send(body),
                () => request.patch(`/api/sections/${section._id}/lessons/reorder`).set(h).send({ lessonIds: [lesson._id] }),
                () => request.get(`/api/lessons/${lesson._id}`).set(h),
                () => request.put(`/api/lessons/${lesson._id}`).set(h).send(body),
                () => request.delete(`/api/lessons/${lesson._id}`).set(h),
                () => request.put(`/api/courses/${course._id}/status`).set(h).send({ status: 'published' }),
                () => request.get(`/api/courses/${course._id}/progress`).set(h),
            ]

            for (const call of calls) {
                const res = await call()

                assert.equal(res.status, 403, `${res.request.method} ${res.request.url}`)
                assert.equal(res.body.code, 'ACCESS_NOT_ACTIVE')
            }

            assert.equal(await models.lessonModel.countDocuments({ course: course._id }), 1)
            assert.equal((await models.courseModel.findById(course._id)).status, 'draft')
        })
    }
})
