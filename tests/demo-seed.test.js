import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcrypt'
import {
    PASSWORD, auth, complete, createCategory, createCourse, createInstructor, createLesson, createStudent, enroll, models, resetDb,
    startTestEnv, stopTestEnv,
} from './helpers.js'
import { issueCertificateIfEligible } from '../src/services/certificates.js'
import { COURSES, DEMO_EMAILS, DEMO_PASSWORD, EXPECTED_STATES, INSTRUCTOR, STUDENTS } from '../scripts/demo/content.js'
import { demoProblems, describeDemo, seedDemo } from '../scripts/demo/seedDemo.js'

// npm run seed:demo (scripts/demo/seedDemo.js): a small, realistic demo workspace built through the
// application's own rules, reset to the same state on every run, never touching other data.
let request

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(resetDb)

const NOW = new Date('2026-10-06T09:00:00.000Z')
const seed = () => seedDemo({ now: NOW, bcryptRounds: 4 })

const EXPECTED_COUNTS = {
    instructors: 1,
    students: 3,
    courses: 3,
    published: 2,
    drafts: 1,
    sections: 7,
    lessons: 16,
    quizzes: 1,
    enrollments: 5,
    completions: 18,
    quizAttempts: 2,
    certificates: 2,
    payments: 1,
}

// everything except ids, dates and random certificate numbers
const shapeOf = (description) => ({
    counts: description.counts,
    courses: description.courses,
    students: description.students,
    states: description.states,
    certificates: description.certificates.map(({ student, course }) => ({ student, course })),
    accessStatus: description.instructor.accessStatus,
})

describe('first run', () => {
    it('builds the designed workspace: personas, courses, states and certificates', async () => {
        const result = await seed()

        assert.deepEqual(demoProblems(result), [])
        assert.deepEqual(result.counts, EXPECTED_COUNTS)
        assert.equal(result.instructor.accessStatus, 'ACTIVE')
        assert.deepEqual(result.courses, [
            { name: 'JavaScript Fundamentals', status: 'published', enrolled: 3 },
            { name: 'Node.js API Design', status: 'draft', enrolled: 0 },
            { name: 'Responsive Web Design', status: 'published', enrolled: 2 },
        ])
        assert.deepEqual(result.certificates.map(({ student, course }) => `${student} / ${course}`), [
            'Citra Wijaya / JavaScript Fundamentals',
            'Citra Wijaya / Responsive Web Design',
        ])
    })

    it('produces the three student states from completion records only (nothing derived is stored)', async () => {
        const { states } = await seed()

        for (const expected of EXPECTED_STATES) {
            const actual = states.find((state) => state.course === expected.course && state.student === expected.student)

            assert.equal(actual.completedLessons, expected.completedLessons, `${expected.student}/${expected.course}`)
            assert.equal(actual.completed, expected.completed)
            assert.equal(actual.certificate, expected.certificate)
        }

        const javascript = states.filter((state) => state.course === 'javascript')

        assert.deepEqual(javascript.map((state) => state.percent), [0, 50, 100])
        assert.equal(await models.lessonProgressModel.countDocuments(), EXPECTED_COUNTS.completions)
    })

    it('a ready final quiz, a failed then a passed attempt, scored by the application', async () => {
        await seed()

        const quiz = await models.quizModel.findOne()
        const attempts = await models.quizAttemptModel.find().sort({ submittedAt: 1 }).lean()

        assert.equal(quiz.questions.length, 4)
        assert.deepEqual(attempts.map((attempt) => [attempt.score, attempt.passed]), [[50, false], [100, true]])
        assert.equal(attempts[1].passingScore, 70)
    })

    it('stores bcrypt hashes and the accounts sign in through the real API with the demo password', async () => {
        await seed()

        for (const email of DEMO_EMAILS) {
            const user = await models.userModel.findOne({ email })

            assert.notEqual(user.password, DEMO_PASSWORD)
            assert.equal(await bcrypt.compare(DEMO_PASSWORD, user.password), true)

            const res = await request.post('/api/sign-in').send({ email, password: DEMO_PASSWORD })

            assert.equal(res.status, 200, email)
            assert.equal(res.body.data.accessStatus, 'ACTIVE')
        }
    })

    it('the API shows what the demo is for: unique students, draft hidden from students, public verification', async () => {
        await seed()

        const instructor = await models.userModel.findOne({ email: INSTRUCTOR.email })
        const overview = (await request.get('/api/overviews').set(auth(instructor))).body.data

        assert.equal(overview.totalStudents, 3, '3 unique students across 5 enrollments')
        assert.equal(overview.publishedCourses, 2)

        const completed = await models.userModel.findOne({ email: STUDENTS.find((s) => s.key === 'completed').email })
        const certificate = await models.certificateModel.findOne({ student: completed._id, courseName: 'JavaScript Fundamentals' })
        const verification = await request.get(`/api/certificates/verify/${certificate.certificateNumber}`)

        assert.equal(verification.status, 200)
        assert.equal(verification.body.data.studentName, 'Citra Wijaya')

        const draft = await models.courseModel.findOne({ name: 'Node.js API Design' })
        const inProgress = await models.userModel.findOne({ email: STUDENTS.find((s) => s.key === 'inProgress').email })

        assert.equal((await request.get(`/api/students-courses/${draft._id}`).set(auth(inProgress))).status, 404)
    })

    it('makes no external request (no Midtrans, no AI provider)', async () => {
        const original = globalThis.fetch
        const calls = []

        globalThis.fetch = async (...args) => {
            calls.push(args)
            throw new Error('no network in the demo seed')
        }

        try {
            await seed()
        } finally {
            globalThis.fetch = original
        }

        assert.equal(calls.length, 0)
    })
})

describe('running again', () => {
    it('resets to exactly the same workspace: no duplicate users, enrollments, certificates or categories', async () => {
        const first = await seed()
        const second = await seed()

        assert.deepEqual(shapeOf(second), shapeOf(first))
        assert.deepEqual(second.removed, { instructors: 1, students: 3, courses: 3, certificates: 2 })

        for (const email of DEMO_EMAILS) assert.equal(await models.userModel.countDocuments({ email }), 1, email)

        for (const course of await models.courseModel.find()) {
            assert.equal(new Set(course.students.map(String)).size, course.students.length, `${course.name} enrollments`)
        }

        const pairs = await models.certificateModel.find().lean()

        assert.equal(new Set(pairs.map((c) => `${c.student}:${c.course}`)).size, pairs.length)
        assert.equal(await models.categoryModel.countDocuments({ name: 'Programming Fundamentals' }), 1)
        assert.equal(await models.lessonModel.countDocuments(), EXPECTED_COUNTS.lessons)
        assert.equal(await models.sectionModel.countDocuments(), EXPECTED_COUNTS.sections)
    })

    it('undoes whatever was done in the demo workspace (new student, new course, extra progress)', async () => {
        await seed()

        const instructor = await models.userModel.findOne({ email: INSTRUCTOR.email })
        const extraStudent = await createStudent(instructor)
        const extraCourse = await createCourse(instructor, await createCategory('Scratch'), { published: true })
        const lesson = await createLesson(extraCourse)
        const notStarted = await models.userModel.findOne({ email: STUDENTS.find((s) => s.key === 'notStarted').email })
        const javascriptLesson = await models.lessonModel.findOne({ title: 'Understanding let and const' })

        await enroll(extraCourse, extraStudent)
        await complete(extraStudent, lesson)
        await models.lessonProgressModel.create({ student: notStarted._id, course: javascriptLesson.course, lesson: javascriptLesson._id })

        const result = await seed()

        assert.deepEqual(demoProblems(result), [])
        assert.deepEqual(result.counts, EXPECTED_COUNTS)
        assert.equal(await models.userModel.countDocuments({ _id: extraStudent._id }), 0)
        assert.equal(await models.courseModel.countDocuments({ _id: extraCourse._id }), 0)
        assert.equal(await models.lessonProgressModel.countDocuments({ student: extraStudent._id }), 0)
    })

    it('never touches other workspaces: their users, courses, progress and certificates survive', async () => {
        const other = await createInstructor({ email: 'owner@other.test' })
        const otherStudent = await createStudent(other, { email: 'learner@other.test' })
        const otherCourse = await createCourse(other, await createCategory('Programming Fundamentals'), { published: true })
        const otherLesson = await createLesson(otherCourse)

        await enroll(otherCourse, otherStudent)
        await complete(otherStudent, otherLesson)
        await issueCertificateIfEligible(otherCourse._id, otherStudent._id)

        await seed()
        await seed()

        assert.equal(await models.userModel.countDocuments({ email: { $in: ['owner@other.test', 'learner@other.test'] } }), 2)
        assert.equal(await models.courseModel.countDocuments({ _id: otherCourse._id }), 1)
        assert.equal(await models.lessonProgressModel.countDocuments({ student: otherStudent._id }), 1)
        assert.equal(await models.certificateModel.countDocuments({ student: otherStudent._id }), 1)
        assert.equal(await models.transactionModel.countDocuments({ user: other._id }), 1)
        assert.equal((await request.post('/api/sign-in').send({ email: 'owner@other.test', password: PASSWORD })).status, 200)
        // the category the other workspace uses is shared, not duplicated
        assert.equal(await models.categoryModel.countDocuments({ name: 'Programming Fundamentals' }), 1)
    })
})

describe('content and safety', () => {
    it('uses realistic titles, never placeholders', async () => {
        await seed()

        const titles = (await models.lessonModel.find().lean()).map((lesson) => lesson.title)

        assert.equal(titles.length, COURSES.reduce((sum, course) => sum + course.sections.reduce((n, s) => n + s.lessons.length, 0), 0))
        for (const title of titles) assert.doesNotMatch(title, /lorem|^lesson \d|asdf|dummy/i)
    })

    it('refuses a demo password that does not satisfy the password policy', async () => {
        await assert.rejects(seedDemo({ now: NOW, password: 'short', bcryptRounds: 4 }))
        assert.equal(await models.userModel.countDocuments(), 0)
    })

    it('every demo account uses the reserved demo domain', () => {
        for (const email of DEMO_EMAILS) assert.match(email, /@cohortly\.local$/)
    })
})
