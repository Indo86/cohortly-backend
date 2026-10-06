import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    auth, createCategory, createCourse, createInstructor, createLesson, createSection, createStudent, enroll, models, resetDb,
    startTestEnv, stopTestEnv,
} from './helpers.js'

// Publish eligibility (services/publishing.js): at least one lesson, and a ready final quiz when there is
// one. While a course is PUBLISHED it must keep at least one lesson: deletes that would empty it are
// refused with 409 PUBLISHED_COURSE_INVARIANT; unpublishing first is the explicit way to empty it.
let request
let instructor
let headers
let category

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(async () => {
    await resetDb()
    instructor = await createInstructor()
    headers = auth(instructor)
    category = await createCategory()
})

const setStatus = (course, status) => request.put(`/api/courses/${course._id}/status`).set(headers).send({ status })
const deleteLesson = (lesson, who = headers) => request.delete(`/api/lessons/${lesson._id}`).set(who)
const deleteSection = (section, who = headers) => request.delete(`/api/sections/${section._id}`).set(who)
const statusOf = async (course) => (await models.courseModel.findById(course._id)).status

const assertInvariantRefusal = (res) => {
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'PUBLISHED_COURSE_INVARIANT')
    assert.equal(res.body.reason, 'COURSE_NOT_PUBLISHABLE')
    assert.match(res.body.message, /at least one lesson/)
}

describe('publishing (the transition)', () => {
    it('a course with a lesson publishes', async () => {
        const course = await createCourse(instructor, category)

        await createLesson(course)

        const res = await setStatus(course, 'published')

        assert.equal(res.status, 200)
        assert.equal(await statusOf(course), 'published')
    })

    it('a course without lessons is refused with 422 COURSE_NOT_PUBLISHABLE and stays a draft', async () => {
        const course = await createCourse(instructor, category)

        await createSection(course)

        const res = await setStatus(course, 'published')

        assert.equal(res.status, 422)
        assert.equal(res.body.code, 'COURSE_NOT_PUBLISHABLE')
        assert.equal(await statusOf(course), 'draft')
    })
})

describe('a published course keeps at least one lesson', () => {
    let course
    let section

    beforeEach(async () => {
        course = await createCourse(instructor, category, { published: true })
        section = await createSection(course, { title: 'Only section' })
    })

    it('deleting its last lesson is refused and changes nothing', async () => {
        const lesson = await createLesson(course, { section })
        const student = await createStudent(instructor)

        await enroll(course, student)
        await models.lessonProgressModel.create({ student: student._id, course: course._id, lesson: lesson._id })

        assertInvariantRefusal(await deleteLesson(lesson))
        assert.equal(await models.lessonModel.countDocuments({ _id: lesson._id }), 1)
        assert.equal(await models.lessonProgressModel.countDocuments({ lesson: lesson._id }), 1, 'progress is untouched')
        assert.equal(await statusOf(course), 'published', 'no silent unpublish')
    })

    it('deleting the section that holds all of its lessons is refused and changes nothing', async () => {
        await createLesson(course, { section })
        await createLesson(course, { section })

        assertInvariantRefusal(await deleteSection(section))
        assert.equal(await models.sectionModel.countDocuments({ _id: section._id }), 1)
        assert.equal(await models.lessonModel.countDocuments({ course: course._id }), 2)
        assert.equal(await statusOf(course), 'published')
    })

    it('deleting a lesson that is not the last one works', async () => {
        const [first, second] = [await createLesson(course, { section }), await createLesson(course, { section })]

        assert.equal((await deleteLesson(first)).status, 200)
        assert.equal(await models.lessonModel.countDocuments({ course: course._id }), 1)

        assertInvariantRefusal(await deleteLesson(second))
    })

    it('deleting a section works while another section still has a lesson, and an empty section can always go', async () => {
        const other = await createSection(course, { title: 'Other section' })
        const empty = await createSection(course, { title: 'Empty section' })

        await createLesson(course, { section })
        await createLesson(course, { section: other })

        assert.equal((await deleteSection(empty)).status, 200)
        assert.equal((await deleteSection(other)).status, 200)
        assert.equal(await models.lessonModel.countDocuments({ course: course._id }), 1)
        assertInvariantRefusal(await deleteSection(section))
    })

    it('editing content keeps working (rename the section, edit the lesson, add a lesson)', async () => {
        const lesson = await createLesson(course, { section })

        assert.equal((await request.put(`/api/sections/${section._id}`).set(headers).send({ title: 'Renamed section' })).status, 200)
        assert.equal((await request.put(`/api/lessons/${lesson._id}`).set(headers).send({ title: 'Edited lesson', type: 'video', youtubeId: 'dQw4w9WgXcQ' })).status, 200)
        assert.equal((await request.post(`/api/sections/${section._id}/lessons`).set(headers).send({ title: 'Added lesson', type: 'text', text: '<p>more</p>' })).status, 201)
        assert.equal(await statusOf(course), 'published')
    })

    it('unpublishing first is the explicit way to empty the course', async () => {
        const lesson = await createLesson(course, { section })

        assert.equal((await setStatus(course, 'draft')).status, 200)
        assert.equal((await deleteLesson(lesson)).status, 200)
        assert.equal((await deleteSection(section)).status, 200)
        assert.equal(await statusOf(course), 'draft')

        // and it cannot be published again while it is empty
        assert.equal((await setStatus(course, 'published')).status, 422)
    })

    it('deleting the whole course is still allowed (it is not "emptying" a published course)', async () => {
        await createLesson(course, { section })

        assert.equal((await request.delete(`/api/courses/${course._id}`).set(headers)).status, 200)
        assert.equal(await models.courseModel.countDocuments({ _id: course._id }), 0)
    })
})

describe('draft courses can be emptied freely (existing behaviour)', () => {
    it('the last lesson and the last section of a draft can be deleted', async () => {
        const course = await createCourse(instructor, category)
        const section = await createSection(course)
        const lesson = await createLesson(course, { section })

        assert.equal((await deleteLesson(lesson)).status, 200)
        assert.equal((await deleteSection(section)).status, 200)
        assert.equal(await models.sectionModel.countDocuments({ course: course._id }), 0)
    })
})

describe('the invariant never weakens ownership', () => {
    it('another instructor still gets the usual 404 (not the invariant error) and nothing changes', async () => {
        const course = await createCourse(instructor, category, { published: true })
        const section = await createSection(course)
        const lesson = await createLesson(course, { section })
        const otherHeaders = auth(await createInstructor())

        for (const res of [await deleteLesson(lesson, otherHeaders), await deleteSection(section, otherHeaders)]) {
            assert.equal(res.status, 404)
            assert.equal(res.body.code, undefined)
        }

        assert.equal(await models.lessonModel.countDocuments({ course: course._id }), 1)
    })

    it('a student is still refused with 403', async () => {
        const course = await createCourse(instructor, category, { published: true })
        const lesson = await createLesson(course)
        const student = await createStudent(instructor)

        await enroll(course, student)
        assert.equal((await deleteLesson(lesson, auth(student))).status, 403)
    })
})
