import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    complete, createCategory, createCourse, createInstructor, createLesson, createQuiz, createSection, createStudent, enroll,
    models, resetDb, startTestEnv, stopTestEnv,
} from './helpers.js'
import { backfillCertificates } from '../src/services/certificates.js'

let instructor
let course
let lessons

before(async () => {
    await startTestEnv()
})
after(stopTestEnv)
beforeEach(async () => {
    await resetDb()
    instructor = await createInstructor()
    course = await createCourse(instructor, await createCategory(), { published: true })

    const section = await createSection(course)

    lessons = [await createLesson(course, { section, title: 'Lesson one' }), await createLesson(course, { section, title: 'Lesson two' })]
})

const certificates = () => models.certificateModel.find({}).lean()
const finishedStudent = async (finishedAt) => {
    const student = await createStudent(instructor)

    await enroll(course, student)

    for (const lesson of lessons) await models.lessonProgressModel.create({ student: student._id, course: course._id, lesson: lesson._id, completedAt: finishedAt })

    return student
}

describe('certificate backfill (historical completions)', () => {
    it('a dry run reports what would be issued and writes nothing', async () => {
        await finishedStudent(new Date('2026-01-10T10:00:00Z'))

        const lines = []
        const report = await backfillCertificates({ dryRun: true, log: (line) => lines.push(line) })

        assert.deepEqual(report, { courses: 1, students: 1, alreadyCertified: 0, eligible: 1, issued: 0 })
        assert.equal((await certificates()).length, 0)
        assert.match(lines[0], /would issue/)
    })

    it('issues certificates for current completions, dated at the last lesson completion, with snapshots', async () => {
        const student = await finishedStudent(new Date('2026-01-10T10:00:00Z'))
        const report = await backfillCertificates()
        const [certificate] = await certificates()

        assert.equal(report.issued, 1)
        assert.equal(certificate.issuedAt.toISOString(), '2026-01-10T10:00:00.000Z')
        assert.equal(certificate.studentName, student.name)
        assert.equal(certificate.courseName, course.name)
        assert.equal(certificate.instructorName, instructor.name)
        assert.match(certificate.certificateNumber, /^COH-\d{4}-/)
    })

    it('is idempotent: a second run issues nothing and the number never changes', async () => {
        await finishedStudent(new Date('2026-01-10T10:00:00Z'))
        await backfillCertificates()

        const [first] = await certificates()
        const again = await backfillCertificates()

        assert.equal(again.issued, 0)
        assert.equal(again.alreadyCertified, 1)
        assert.equal((await certificates()).length, 1)
        assert.equal((await certificates())[0].certificateNumber, first.certificateNumber)
    })

    it('skips draft courses: only published courses issue certificates', async () => {
        await finishedStudent(new Date('2026-01-10T10:00:00Z'))
        await models.courseModel.updateOne({ _id: course._id }, { status: 'draft' })

        const report = await backfillCertificates()

        assert.deepEqual(report, { courses: 0, students: 0, alreadyCertified: 0, eligible: 0, issued: 0 })
        assert.equal((await certificates()).length, 0)
    })

    it('skips students who have not completed the course', async () => {
        const partial = await createStudent(instructor)

        await enroll(course, partial)
        await complete(partial, lessons[0])

        const report = await backfillCertificates()

        assert.equal(report.eligible, 0)
        assert.equal((await certificates()).length, 0)
    })

    it('for a course with a quiz it needs a PASSED attempt, and is dated at the later of lessons and first pass', async () => {
        const quiz = await createQuiz(course, { questions: 2, passingScore: 50 })
        const waiting = await finishedStudent(new Date('2026-01-10T10:00:00Z'))
        const passer = await finishedStudent(new Date('2026-01-10T10:00:00Z'))

        await models.quizAttemptModel.create({
            quiz: quiz._id, course: course._id, student: waiting._id, answers: [], totalQuestions: 2, correctAnswers: 0, score: 0, passingScore: 50, passed: false,
        })
        await models.quizAttemptModel.create({
            quiz: quiz._id, course: course._id, student: passer._id, answers: [], totalQuestions: 2, correctAnswers: 2, score: 100, passingScore: 50, passed: true,
            submittedAt: new Date('2026-02-01T08:00:00Z'),
        })

        const report = await backfillCertificates()
        const issued = await certificates()

        assert.equal(report.eligible, 1)
        assert.equal(issued.length, 1)
        assert.equal(String(issued[0].student), String(passer._id))
        assert.equal(issued[0].issuedAt.toISOString(), '2026-02-01T08:00:00.000Z')
        assert.equal(issued[0].finalScore, 100)
    })

    it('does not touch students who already have a certificate', async () => {
        const student = await finishedStudent(new Date('2026-01-10T10:00:00Z'))

        await models.certificateModel.create({
            student: student._id, course: course._id, certificateNumber: 'COH-2025-ABCDEFGH', studentName: 'Old Name', courseName: 'Old Course',
            instructorName: 'Old Instructor', totalLessons: 2, issuedAt: new Date('2025-05-05T00:00:00Z'),
        })

        const report = await backfillCertificates()
        const [certificate] = await certificates()

        assert.equal(report.issued, 0)
        assert.equal(report.alreadyCertified, 1)
        assert.equal(certificate.certificateNumber, 'COH-2025-ABCDEFGH')
        assert.equal(certificate.studentName, 'Old Name')
    })
})
