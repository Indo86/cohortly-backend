import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    auth, complete, createCategory, createCourse, createInstructor, createLesson, createSection, createStudent,
    daysAgo, enroll, models, pay, resetDb, startTestEnv, stopTestEnv,
} from './helpers.js'

let request
let instructor
let student
let course
let s1
let s2
let lessons // [l1, l2] in s1, [l3] in s2  => course order l1, l2, l3
let headers
let studentHeaders

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(async () => {
    await resetDb()
    instructor = await createInstructor()
    student = await createStudent(instructor)
    course = await createCourse(instructor, await createCategory(), { published: true })
    s1 = await createSection(course, { title: 'Basics' })
    s2 = await createSection(course, { title: 'Advanced' })
    lessons = [
        await createLesson(course, { section: s1, title: 'Lesson one' }),
        await createLesson(course, { section: s1, title: 'Lesson two' }),
        await createLesson(course, { section: s2, title: 'Lesson three' }),
    ]
    await enroll(course, student)
    headers = auth(instructor)
    studentHeaders = auth(student)
})

const complete_ = (lesson) => request.put(`/api/lessons/${lesson._id}/completion`).set(studentHeaders)
const undo = (lesson) => request.delete(`/api/lessons/${lesson._id}/completion`).set(studentHeaders)
const courseView = async () => (await request.get(`/api/students-courses/${course._id}`).set(studentHeaders)).body.data
const dashboard = async () => (await request.get('/api/students-courses').set(studentHeaders)).body.data

describe('student learning read model', () => {
    it('returns the course with ordered sections and lessons, completion state and progress', async () => {
        const data = await courseView()

        assert.equal(data.name, course.name)
        assert.ok(data.thumbnail_url)
        assert.deepEqual(data.sections.map((s) => s.title), ['Basics', 'Advanced'])
        assert.deepEqual(data.sections[0].lessons.map((l) => l.title), ['Lesson one', 'Lesson two'])
        assert.deepEqual(data.sections[0].lessons.map((l) => l.completed), [false, false])
        assert.deepEqual(data.progress, { completedLessons: 0, totalLessons: 3, percent: 0, completed: false })
        assert.equal(data.nextLesson.title, 'Lesson one')
        assert.equal(data.nextLesson.sectionTitle, 'Basics')
        assert.equal(data.lastActivityAt, null)
    })

    it('does not expose management metadata, other students or lesson content in the course view', async () => {
        const other = await createStudent(instructor)
        await enroll(course, other)

        const text = JSON.stringify(await courseView())

        for (const forbidden of ['"students"', '"manager"', '"status"', 'hello world', '"text":', 'youtubeId']) {
            assert.equal(text.includes(forbidden), false, forbidden)
        }
    })

    it('follows the instructor ordering: reordering sections changes what the student sees', async () => {
        await request
            .patch(`/api/courses/${course._id}/sections/reorder`)
            .set(headers)
            .send({ sectionIds: [s2._id, s1._id] })

        const data = await courseView()

        assert.deepEqual(data.sections.map((s) => s.title), ['Advanced', 'Basics'])
        assert.equal(data.nextLesson.title, 'Lesson three')
    })

    it('omits sections that have no lessons', async () => {
        await createSection(course, { title: 'Empty section' })

        assert.deepEqual((await courseView()).sections.map((s) => s.title), ['Basics', 'Advanced'])
    })

    it('serves one lesson with content and previous/next navigation, in course order', async () => {
        const first = await request.get(`/api/students-courses/${course._id}/lessons/${lessons[0]._id}`).set(studentHeaders)
        const middle = await request.get(`/api/students-courses/${course._id}/lessons/${lessons[1]._id}`).set(studentHeaders)
        const last = await request.get(`/api/students-courses/${course._id}/lessons/${lessons[2]._id}`).set(studentHeaders)

        assert.equal(first.body.data.text, '<p>hello world</p>')
        assert.equal(first.body.data.previousLessonId, null)
        assert.equal(first.body.data.nextLessonId, lessons[1]._id.toString())
        assert.equal(middle.body.data.nextLessonId, lessons[2]._id.toString(), 'navigation crosses sections')
        assert.equal(middle.body.data.previousLessonId, lessons[0]._id.toString())
        assert.equal(last.body.data.nextLessonId, null)
        assert.equal(last.body.data.sectionTitle, 'Advanced')
    })

    it('a lesson requested through the wrong course is a 404', async () => {
        const other = await createCourse(instructor, await createCategory('Other'), { published: true })
        await enroll(other, student)

        const res = await request.get(`/api/students-courses/${other._id}/lessons/${lessons[0]._id}`).set(studentHeaders)

        assert.equal(res.status, 404)
    })
})

describe('lesson completion', () => {
    it('marks a lesson complete, persists it, and returns the new progress', async () => {
        const res = await complete_(lessons[0])

        assert.equal(res.status, 200)
        assert.equal(res.body.data.completed, true)
        assert.ok(res.body.data.completedAt)
        assert.deepEqual(res.body.data.progress, { completedLessons: 1, totalLessons: 3, percent: 33, completed: false })
        assert.equal(res.body.data.nextLesson.title, 'Lesson two')

        const stored = await models.lessonProgressModel.findOne({ student: student._id, lesson: lessons[0]._id })
        assert.equal(String(stored.course), String(course._id), 'the course comes from the lesson, not the client')
    })

    it('persists across sessions (a fresh sign-in sees the same progress)', async () => {
        await complete_(lessons[0])
        await complete_(lessons[1])

        const login = await request.post('/api/sign-in').send({ email: student.email, password: 'secret-pass-1' })
        const again = await request
            .get(`/api/students-courses/${course._id}`)
            .set({ Authorization: `JWT ${login.body.data.token}` })

        assert.equal(again.body.data.progress.completedLessons, 2)
        assert.deepEqual(again.body.data.sections[0].lessons.map((l) => l.completed), [true, true])
    })

    it('is idempotent: completing again keeps one record and the original completion time', async () => {
        const first = await complete_(lessons[0])
        const second = await complete_(lessons[0])

        assert.equal(second.status, 200)
        assert.equal(second.body.data.completedAt, first.body.data.completedAt)
        assert.equal(second.body.data.progress.completedLessons, 1)
        assert.equal(await models.lessonProgressModel.countDocuments({ student: student._id }), 1)
    })

    it('concurrent completions create exactly one record', async () => {
        const results = await Promise.all(Array.from({ length: 6 }, () => complete_(lessons[0])))

        assert.ok(results.every((res) => res.status === 200))
        assert.equal(await models.lessonProgressModel.countDocuments({ student: student._id, lesson: lessons[0]._id }), 1)
    })

    it('the database enforces one completion per student and lesson', async () => {
        await complete(student, lessons[0])

        await assert.rejects(complete(student, lessons[0]), { code: 11000 })
    })

    it('undo removes the completion and recalculates; undoing again succeeds (idempotent)', async () => {
        await complete_(lessons[0])
        await complete_(lessons[1])

        const undone = await undo(lessons[1])

        assert.equal(undone.status, 200)
        assert.equal(undone.body.data.completed, false)
        assert.equal(undone.body.data.progress.completedLessons, 1)
        assert.equal(undone.body.data.nextLesson.title, 'Lesson two')

        const again = await undo(lessons[1])
        assert.equal(again.status, 200)
        assert.equal(again.body.data.progress.completedLessons, 1)
        assert.equal(await models.lessonProgressModel.countDocuments({ student: student._id }), 1)
    })

    it('keeps one student progress separate from another student', async () => {
        const other = await createStudent(instructor)
        await enroll(course, other)

        await complete_(lessons[0])

        const res = await request.get(`/api/students-courses/${course._id}`).set(auth(other))
        assert.equal(res.body.data.progress.completedLessons, 0)
    })

    it('is blocked for an unenrolled student (404) and records nothing', async () => {
        const stranger = await createStudent(instructor)

        const res = await request.put(`/api/lessons/${lessons[0]._id}/completion`).set(auth(stranger))

        assert.equal(res.status, 404)
        assert.equal(await models.lessonProgressModel.countDocuments(), 0)
    })

    it('is blocked for a student of another instructor, and for a lesson of an unenrolled course', async () => {
        const otherInstructor = await createInstructor()
        const foreignStudent = await createStudent(otherInstructor)
        const hidden = await createCourse(instructor, await createCategory('Hidden'), { published: true })
        const hiddenLesson = await createLesson(hidden)

        assert.equal((await request.put(`/api/lessons/${lessons[0]._id}/completion`).set(auth(foreignStudent))).status, 404)
        assert.equal((await complete_(hiddenLesson)).status, 404, 'enrolled in a different course')
        assert.equal(await models.lessonProgressModel.countDocuments(), 0)
    })

    it('is blocked while the course is a draft (404), for both completing and undoing', async () => {
        await request.put(`/api/courses/${course._id}/status`).set(headers).send({ status: 'draft' })

        assert.equal((await complete_(lessons[0])).status, 404)
        assert.equal((await undo(lessons[0])).status, 404)
        assert.equal(await models.lessonProgressModel.countDocuments(), 0)
    })

    it('answers 404 for an unknown lesson and 400 for a malformed id', async () => {
        assert.equal((await request.put('/api/lessons/64b64b64b64b64b64b64b64b/completion').set(studentHeaders)).status, 404)
        assert.equal((await request.put('/api/lessons/oops/completion').set(studentHeaders)).status, 400)
    })
})

describe('progress calculation and course completion', () => {
    it('counts and percentages are right at every step, 100 only when everything is done', async () => {
        const steps = []

        for (const lesson of lessons) {
            steps.push((await complete_(lesson)).body.data.progress)
        }

        assert.deepEqual(steps.map((p) => [p.completedLessons, p.totalLessons, p.percent, p.completed]), [
            [1, 3, 33, false],
            [2, 3, 66, false],
            [3, 3, 100, true],
        ])
        assert.equal((await courseView()).nextLesson, null)
    })

    it('a course without lessons is 0 percent and never completed', async () => {
        const empty = await createCourse(instructor, await createCategory('Empty'), { published: true })
        await enroll(empty, student)

        const item = (await dashboard()).find((c) => c._id === empty._id.toString())

        assert.deepEqual(item.progress, { completedLessons: 0, totalLessons: 0, percent: 0, completed: false })
        assert.equal(item.nextLesson, null)
    })

    it('adding a lesson re-opens a completed course', async () => {
        for (const lesson of lessons) await complete_(lesson)
        assert.equal((await courseView()).progress.completed, true)

        const created = await request
            .post(`/api/sections/${s2._id}/lessons`)
            .set(headers)
            .send({ title: 'Brand new lesson', type: 'text', text: '<p>fresh content</p>' })

        const data = await courseView()
        assert.deepEqual(data.progress, { completedLessons: 3, totalLessons: 4, percent: 75, completed: false })
        assert.equal(data.nextLesson._id, created.body.data._id)
    })

    it('deleting a lesson recalculates from the remaining lessons (and can complete the course)', async () => {
        await complete_(lessons[0])
        await complete_(lessons[1])

        await request.delete(`/api/lessons/${lessons[2]._id}`).set(headers)

        const data = await courseView()
        assert.deepEqual(data.progress, { completedLessons: 2, totalLessons: 2, percent: 100, completed: true })
        assert.equal(data.nextLesson, null)
    })

    it('deleting a completed lesson lowers the completed count', async () => {
        await complete_(lessons[0])
        await complete_(lessons[1])

        await request.delete(`/api/lessons/${lessons[0]._id}`).set(headers)

        assert.deepEqual((await courseView()).progress, { completedLessons: 1, totalLessons: 2, percent: 50, completed: false })
    })

    it('undoing a completion re-opens a completed course', async () => {
        for (const lesson of lessons) await complete_(lesson)

        await undo(lessons[2])

        const data = await courseView()
        assert.equal(data.progress.completed, false)
        assert.equal(data.progress.percent, 66)
        assert.equal(data.nextLesson.title, 'Lesson three')
    })

    it('deleting a section recalculates progress too', async () => {
        await complete_(lessons[2])

        await request.delete(`/api/sections/${s2._id}`).set(headers)

        assert.deepEqual((await courseView()).progress, { completedLessons: 0, totalLessons: 2, percent: 0, completed: false })
    })

    it('stores no percentage anywhere: only completion records', async () => {
        await complete_(lessons[0])

        const stored = (await models.lessonProgressModel.findOne()).toObject()

        assert.deepEqual(Object.keys(stored).sort(), ['__v', '_id', 'completedAt', 'course', 'lesson', 'student'])
        const storedCourse = (await models.courseModel.findById(course._id)).toObject()
        assert.equal('percent' in storedCourse || 'progress' in storedCourse || 'completed' in storedCourse, false)
    })
})

describe('continue learning', () => {
    it('next lesson is the first incomplete lesson in section order then lesson order', async () => {
        assert.equal((await courseView()).nextLesson.title, 'Lesson one')

        await complete_(lessons[0])
        assert.equal((await courseView()).nextLesson.title, 'Lesson two')

        await complete_(lessons[1])
        const next = (await courseView()).nextLesson
        assert.equal(next.title, 'Lesson three')
        assert.equal(next.sectionTitle, 'Advanced')
        assert.equal(String(next.sectionId), String(s2._id))
    })

    it('skips completed lessons and returns to a gap', async () => {
        await complete_(lessons[0])
        await complete_(lessons[2])

        assert.equal((await courseView()).nextLesson.title, 'Lesson two')
    })

    it('is null when everything is complete, and comes back after an undo', async () => {
        for (const lesson of lessons) await complete_(lesson)
        assert.equal((await courseView()).nextLesson, null)

        await undo(lessons[1])
        assert.equal((await courseView()).nextLesson.title, 'Lesson two')
    })

    it('the dashboard lists every published enrolled course with progress and its next lesson', async () => {
        const second = await createCourse(instructor, await createCategory('Second'), { published: true })
        const only = await createLesson(second, { title: 'Only lesson' })
        await enroll(second, student)
        await createCourse(instructor, await createCategory('Draft'), { published: false })
        await complete_(lessons[0])
        await complete(student, only)

        const data = await dashboard()
        const first = data.find((c) => c._id === course._id.toString())
        const done = data.find((c) => c._id === second._id.toString())

        assert.equal(data.length, 2)
        assert.deepEqual(first.progress, { completedLessons: 1, totalLessons: 3, percent: 33, completed: false })
        assert.equal(first.nextLesson.title, 'Lesson two')
        assert.equal(done.progress.completed, true)
        assert.equal(done.nextLesson, null)
        assert.ok(first.thumbnail_url && first.category.name)
    })

    it('a draft enrolled course is left out of the dashboard', async () => {
        const draft = await createCourse(instructor, await createCategory('Draft'), { published: false })
        await createLesson(draft)
        await enroll(draft, student)

        assert.equal((await dashboard()).some((c) => c._id === draft._id.toString()), false)
    })
})

describe('instructor progress view', () => {
    it('shows each enrolled learner with counts, percent, completion, next lesson and last activity', async () => {
        const second = await createStudent(instructor)
        await enroll(course, second)
        await complete_(lessons[0])
        await complete_(lessons[1])
        await complete(second, lessons[0])
        for (const lesson of lessons) if (String(lesson._id) !== String(lessons[0]._id)) await complete(second, lesson)

        const res = await request.get(`/api/courses/${course._id}/progress`).set(headers)

        assert.equal(res.status, 200)
        assert.deepEqual(res.body.data.course, { _id: course._id.toString(), name: course.name, status: 'published', totalLessons: 3 })
        assert.deepEqual(res.body.data.summary, { enrolledLearners: 2, completedLearners: 1, certificatesIssued: 0 })

        const mine = res.body.data.students.find((s) => s._id === student._id.toString())
        const done = res.body.data.students.find((s) => s._id === second._id.toString())

        assert.deepEqual(mine.progress, { completedLessons: 2, totalLessons: 3, percent: 66, completed: false })
        assert.equal(mine.nextLesson.title, 'Lesson three')
        assert.ok(mine.lastActivityAt)
        assert.equal(done.progress.completed, true)
        assert.equal(done.nextLesson, null)
        // the test students never uploaded an avatar: no URL, the client shows initials
        assert.equal(done.photo_url, null)
        assert.equal(JSON.stringify(res.body).includes('password'), false)
    })

    it('lists learners without any activity with zero progress and no last activity', async () => {
        const res = await request.get(`/api/courses/${course._id}/progress`).set(headers)

        assert.equal(res.body.data.students.length, 1)
        assert.deepEqual(res.body.data.students[0].progress, { completedLessons: 0, totalLessons: 3, percent: 0, completed: false })
        assert.equal(res.body.data.students[0].lastActivityAt, null)
    })

    it('contains only students enrolled in that course, never other users', async () => {
        const notEnrolled = await createStudent(instructor)
        const otherInstructor = await createInstructor()
        await createStudent(otherInstructor)

        const res = await request.get(`/api/courses/${course._id}/progress`).set(headers)

        assert.deepEqual(res.body.data.students.map((s) => s._id), [student._id.toString()])
        assert.equal(res.body.data.students.some((s) => s._id === notEnrolled._id.toString()), false)
    })

    it('works for a draft course and keeps showing preserved progress', async () => {
        await complete_(lessons[0])
        await request.put(`/api/courses/${course._id}/status`).set(headers).send({ status: 'draft' })

        const res = await request.get(`/api/courses/${course._id}/progress`).set(headers)

        assert.equal(res.status, 200)
        assert.equal(res.body.data.course.status, 'draft')
        assert.equal(res.body.data.students[0].progress.completedLessons, 1)
    })

    it('reflects content changes immediately', async () => {
        for (const lesson of lessons) await complete_(lesson)
        assert.equal((await request.get(`/api/courses/${course._id}/progress`).set(headers)).body.data.summary.completedLearners, 1)

        await createLesson(course, { section: s2, title: 'Late addition' })

        const after = await request.get(`/api/courses/${course._id}/progress`).set(headers)
        assert.equal(after.body.data.summary.completedLearners, 0)
        assert.equal(after.body.data.course.totalLessons, 4)
    })
})

describe('deleting and unenrolling students', () => {
    it('unenrolling deletes that student progress for the course only, and re-enrolling starts from zero', async () => {
        const other = await createCourse(instructor, await createCategory('Other'), { published: true })
        const otherLesson = await createLesson(other)
        await enroll(other, student)
        await complete_(lessons[0])
        await complete(student, otherLesson)

        const res = await request.put(`/api/courses/students/${course._id}`).set(headers).send({ studentId: student._id })

        assert.equal(res.status, 200)
        assert.equal(await models.lessonProgressModel.countDocuments({ course: course._id }), 0)
        assert.equal(await models.lessonProgressModel.countDocuments({ course: other._id }), 1)

        await request.post(`/api/courses/students/${course._id}`).set(headers).send({ studentId: student._id })
        assert.equal((await courseView()).progress.completedLessons, 0)
    })

    it('deleting a student deletes all their progress and keeps other students', async () => {
        const other = await createStudent(instructor)
        await enroll(course, other)
        await complete_(lessons[0])
        await complete(other, lessons[0])

        const res = await request.delete(`/api/students/${student._id}`).set(headers)

        assert.equal(res.status, 200)
        assert.equal(await models.lessonProgressModel.countDocuments({ student: student._id }), 0)
        assert.equal(await models.lessonProgressModel.countDocuments({ student: other._id }), 1)
        assert.equal(
            (await request.get(`/api/courses/${course._id}/progress`).set(headers)).body.data.students.length,
            1
        )
    })
})

describe('hard entitlement on the student learning endpoints', () => {
    const studentCalls = () => [
        () => request.get('/api/students-courses').set(studentHeaders),
        () => request.get(`/api/students-courses/${course._id}`).set(studentHeaders),
        () => request.get(`/api/students-courses/${course._id}/lessons/${lessons[0]._id}`).set(studentHeaders),
        () => request.put(`/api/lessons/${lessons[0]._id}/completion`).set(studentHeaders),
        () => request.delete(`/api/lessons/${lessons[0]._id}/completion`).set(studentHeaders),
    ]

    it('allows every student learning call while the instructor workspace is ACTIVE', async () => {
        for (const call of studentCalls()) {
            const res = await call()

            assert.equal(res.status, 200, `${res.request.method} ${res.request.url}`)
        }
    })

    for (const state of ['NONE', 'PENDING', 'FAILED', 'EXPIRED']) {
        it(`blocks every student learning call when the instructor workspace is ${state}`, async () => {
            await models.transactionModel.deleteMany({ user: instructor._id })
            if (state === 'PENDING') await pay(instructor, { status: 'pending' })
            if (state === 'FAILED') await pay(instructor, { status: 'failed' })
            if (state === 'EXPIRED') await pay(instructor, { paidAt: daysAgo(45) })

            for (const call of studentCalls()) {
                const res = await call()

                assert.equal(res.status, 403, `${res.request.method} ${res.request.url}`)
                assert.equal(res.body.code, 'WORKSPACE_ACCESS_INACTIVE')
                assert.equal(res.body.accessStatus, state)
            }

            assert.equal(await models.lessonProgressModel.countDocuments(), 0, 'nothing was recorded')
        })
    }

    it('preserves progress while inactive and restores it after renewal', async () => {
        await complete_(lessons[0])
        await models.transactionModel.deleteMany({ user: instructor._id })
        await pay(instructor, { paidAt: daysAgo(45) })

        assert.equal((await complete_(lessons[1])).status, 403)
        assert.equal(await models.lessonProgressModel.countDocuments({ student: student._id }), 1)

        await pay(instructor)
        assert.equal((await courseView()).progress.completedLessons, 1)
    })
})
