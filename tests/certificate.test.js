import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    answersFor, auth, createCategory, createCourse, createInstructor, createLesson, createQuiz, createSection, createStudent,
    daysAgo, enroll, models, pay, resetDb, startTestEnv, stopTestEnv,
} from './helpers.js'
import { issueCertificateIfEligible } from '../src/services/certificates.js'
import { generateCertificateNumber, CERTIFICATE_NUMBER_PATTERN } from '../src/utils/certificateNumber.js'

let request
let instructor
let student
let course
let lessons
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

    const section = await createSection(course, { title: 'Basics' })

    lessons = [await createLesson(course, { section, title: 'Lesson one' }), await createLesson(course, { section, title: 'Lesson two' })]
    await enroll(course, student)
    studentHeaders = auth(student)
})

const completeLesson = (lesson, who = studentHeaders) => request.put(`/api/lessons/${lesson._id}/completion`).set(who)
const finishLessons = async () => {
    for (const lesson of lessons) await completeLesson(lesson)
}
const certificates = (filter = {}) => models.certificateModel.find(filter).lean()
const verify = (number) => request.get(`/api/certificates/verify/${number}`)
const withQuiz = async (options) => createQuiz(course, options)
const submit = (quiz, correct, who = studentHeaders) =>
    request.post(`/api/students-courses/${course._id}/quiz/attempts`).set(who).send({ answers: answersFor(quiz, correct) })

describe('certificate number', () => {
    it('is opaque, human readable and not based on a database id', () => {
        const number = generateCertificateNumber(new Date('2026-03-01T00:00:00Z'))

        assert.match(number, /^COH-2026-[2-9A-HJKMNP-TV-Z]{8}$/)
        assert.ok(CERTIFICATE_NUMBER_PATTERN.test(number))
    })

    it('does not repeat (random, not sequential)', () => {
        const numbers = new Set(Array.from({ length: 5000 }, () => generateCertificateNumber()))

        assert.equal(numbers.size, 5000)
    })

    it('the database refuses a duplicate number and a second certificate for the same student and course', async () => {
        await finishLessons()

        const [existing] = await certificates()
        const other = await createStudent(instructor)
        const copy = { ...existing, _id: undefined }

        delete copy._id

        await assert.rejects(models.certificateModel.collection.insertOne({ ...copy, student: other._id }), /E11000/) // same number
        await assert.rejects(models.certificateModel.collection.insertOne({ ...copy, certificateNumber: 'COH-2026-ABCDEFGH' }), /E11000/) // same student + course
    })
})

describe('issuance for a course WITHOUT a quiz (backward compatibility)', () => {
    it('issues the certificate when the last lesson is completed, and not before', async () => {
        const first = await completeLesson(lessons[0])

        assert.equal(first.body.data.certificateIssued, false)
        assert.equal(first.body.data.certificate, null)
        assert.equal((await certificates()).length, 0)

        const last = await completeLesson(lessons[1])

        assert.equal(last.body.data.certificateIssued, true)
        assert.equal(last.body.data.progress.completed, true)
        assert.match(last.body.data.certificate.certificateNumber, /^COH-\d{4}-/)
        assert.equal((await certificates()).length, 1)
    })

    it('stores a snapshot of the names, the lesson count and an immutable number', async () => {
        await finishLessons()

        const [certificate] = await certificates()

        assert.equal(certificate.studentName, student.name)
        assert.equal(certificate.courseName, course.name)
        assert.equal(certificate.instructorName, instructor.name)
        assert.equal(certificate.totalLessons, 2)
        assert.equal(certificate.finalScore, null)
        assert.ok(certificate.issuedAt)
        assert.equal(String(certificate.student), String(student._id))

        const doc = await models.certificateModel.findById(certificate._id)

        doc.certificateNumber = 'COH-2026-HACKED22'
        doc.studentName = 'Someone Else'
        await doc.save()

        const again = await models.certificateModel.findById(certificate._id).lean()

        assert.equal(again.certificateNumber, certificate.certificateNumber)
        assert.equal(again.studentName, student.name)
    })

    it('is idempotent: repeating completions, undo and redo never create a second certificate or change the number', async () => {
        await finishLessons()

        const [first] = await certificates()

        await completeLesson(lessons[1])
        await completeLesson(lessons[1])
        await request.delete(`/api/lessons/${lessons[1]._id}/completion`).set(studentHeaders)

        const redo = await completeLesson(lessons[1])

        assert.equal(redo.body.data.certificateIssued, false) // already had one
        assert.equal(redo.body.data.certificate.certificateNumber, first.certificateNumber)

        const all = await certificates()

        assert.equal(all.length, 1)
        assert.equal(all[0].certificateNumber, first.certificateNumber)
    })

    it('concurrent completions of the last lesson create exactly one certificate', async () => {
        await completeLesson(lessons[0])

        const results = await Promise.all(Array.from({ length: 8 }, () => completeLesson(lessons[1])))

        assert.ok(results.every((r) => r.status === 200))
        assert.equal((await certificates()).length, 1)
        assert.equal(new Set(results.map((r) => r.body.data.certificate.certificateNumber)).size, 1)
        assert.equal(results.filter((r) => r.body.data.certificateIssued).length <= 1, true)
    })

    it('concurrent direct issuance (service level) also creates exactly one', async () => {
        await models.lessonProgressModel.insertMany(lessons.map((l) => ({ student: student._id, course: course._id, lesson: l._id })))

        const results = await Promise.all(Array.from({ length: 12 }, () => issueCertificateIfEligible(course._id, student._id)))

        assert.equal((await certificates()).length, 1)
        assert.equal(results.filter((r) => r.issued).length, 1)
        assert.equal(new Set(results.map((r) => r.certificate.certificateNumber)).size, 1)
    })

    it('is never issued to someone who has not completed the course', async () => {
        const result = await issueCertificateIfEligible(course._id, student._id)

        assert.deepEqual([result.certificate, result.issued, result.eligible], [null, false, false])
        await completeLesson(lessons[0])
        assert.equal((await certificates()).length, 0)
    })

    it('belongs to one student: another enrolled student has to finish the course themself', async () => {
        const other = await createStudent(instructor)

        await enroll(course, other)
        await finishLessons()
        assert.equal((await certificates({ student: other._id })).length, 0)
    })
})

describe('issuance for a course WITH a quiz', () => {
    let quiz

    beforeEach(async () => {
        quiz = await withQuiz({ questions: 3, passingScore: 70 })
    })

    it('completing the lessons alone issues nothing; failing issues nothing; passing issues exactly one', async () => {
        await finishLessons()
        assert.equal((await certificates()).length, 0)

        assert.equal((await submit(quiz, 1)).body.data.certificateIssued, false)
        assert.equal((await certificates()).length, 0)

        const pass = await submit(quiz, 3)

        assert.equal(pass.body.data.certificateIssued, true)

        const [certificate] = await certificates()

        assert.equal(certificate.finalScore, 100)
        assert.equal(certificate.totalLessons, 2)
    })

    it('retrying or re-passing the quiz never creates another certificate or changes it', async () => {
        await finishLessons()
        await submit(quiz, 3)

        const [first] = await certificates()

        await submit(quiz, 3)
        await submit(quiz, 0)
        await submit(quiz, 2)

        const all = await certificates()

        assert.equal(all.length, 1)
        assert.equal(all[0].certificateNumber, first.certificateNumber)
        assert.equal(all[0].finalScore, 100)
        assert.equal(String(all[0].issuedAt), String(first.issuedAt))
    })

    it('concurrent passing submissions create exactly one certificate', async () => {
        await finishLessons()

        const results = await Promise.all(Array.from({ length: 6 }, () => submit(quiz, 3)))

        assert.ok(results.every((r) => r.status === 201))
        assert.equal((await certificates()).length, 1)
        assert.equal(await models.quizAttemptModel.countDocuments({}), 6)
    })

    it('a pass does not issue when a lesson was added meanwhile (the quiz is locked again)', async () => {
        await finishLessons()
        await createLesson(course, { title: 'Late lesson' })

        const res = await submit(quiz, 3)

        assert.equal(res.status, 409)
        assert.equal((await certificates()).length, 0)
    })
})

describe('a certificate is HISTORY: later changes do not touch it', () => {
    let quiz

    beforeEach(async () => {
        quiz = await withQuiz({ questions: 2, passingScore: 50 })
        await finishLessons()
        await submit(quiz, 2)
    })

    it('adding a lesson reopens the live course but the certificate stays valid', async () => {
        const [issued] = await certificates()

        await createLesson(course, { title: 'A new lesson' })

        const view = (await request.get(`/api/students-courses/${course._id}`).set(studentHeaders)).body.data

        assert.equal(view.progress.completed, false) // live progress follows the current content
        assert.equal(view.certificate.certificateNumber, issued.certificateNumber) // the certificate is still there

        const check = await verify(issued.certificateNumber)

        assert.equal(check.status, 200)
        assert.equal(check.body.data.valid, true)
        assert.equal((await certificates()).length, 1)
    })

    it('editing the quiz (questions, passing score) changes neither attempts nor the certificate', async () => {
        const [issued] = await certificates()
        const attemptBefore = await models.quizAttemptModel.findOne({}).lean()

        await models.quizModel.updateOne({ _id: quiz._id }, { passingScore: 100, $set: { questions: [] } })

        assert.equal((await certificates()).length, 1)
        assert.equal((await verify(issued.certificateNumber)).status, 200)
        assert.deepEqual(await models.quizAttemptModel.findOne({}).lean(), attemptBefore)
    })

    it('renaming the course or the instructor does not rewrite the certificate', async () => {
        const [issued] = await certificates()

        await models.courseModel.updateOne({ _id: course._id }, { name: 'A Completely New Course Name' })
        await models.userModel.updateOne({ _id: instructor._id }, { name: 'Renamed Instructor' })
        await models.userModel.updateOne({ _id: student._id }, { name: 'Renamed Student' })

        const check = await verify(issued.certificateNumber)

        assert.equal(check.body.data.courseName, course.name)
        assert.equal(check.body.data.instructorName, instructor.name)
        assert.equal(check.body.data.studentName, student.name)
    })

    it('undoing a lesson completion does not revoke it', async () => {
        await request.delete(`/api/lessons/${lessons[0]._id}/completion`).set(studentHeaders)
        assert.equal((await certificates()).length, 1)
    })
})

describe('deletion policy', () => {
    let quiz

    beforeEach(async () => {
        quiz = await withQuiz({ questions: 2, passingScore: 50 })
        await finishLessons()
        await submit(quiz, 2)
    })

    it('deleting the quiz keeps the certificate and the attempts', async () => {
        const [issued] = await certificates()
        const res = await request.delete(`/api/quizzes/${quiz._id}`).set(auth(instructor))

        assert.equal(res.status, 200)
        assert.equal((await certificates()).length, 1)
        assert.equal((await verify(issued.certificateNumber)).status, 200)
        assert.equal(await models.quizAttemptModel.countDocuments({ quiz: quiz._id }), 1)
    })

    it('deleting a question keeps attempts and the certificate', async () => {
        const res = await request.delete(`/api/quizzes/${quiz._id}/questions/${quiz.questions[0]._id}`).set(auth(instructor))

        assert.equal(res.status, 200)
        assert.equal((await certificates()).length, 1)
        assert.equal(await models.quizAttemptModel.countDocuments({}), 1)
    })

    it('deleting the COURSE removes its learning data (progress, attempts, quiz) but NOT the certificate, which stays verifiable', async () => {
        const [issued] = await certificates()
        const res = await request.delete(`/api/courses/${course._id}`).set(auth(instructor))

        assert.equal(res.status, 200)
        assert.equal(await models.quizModel.countDocuments({}), 0)
        assert.equal(await models.quizAttemptModel.countDocuments({}), 0)
        assert.equal(await models.lessonProgressModel.countDocuments({}), 0)
        assert.equal((await certificates()).length, 1)

        const check = await verify(issued.certificateNumber)

        assert.equal(check.status, 200)
        assert.equal(check.body.data.courseName, course.name)

        const own = await request.get(`/api/my-certificates/${issued.certificateNumber}`).set(studentHeaders)

        assert.equal(own.status, 200)
    })

    it('deleting the STUDENT removes progress and attempts; the issued certificate record is kept (documented policy)', async () => {
        const [issued] = await certificates()
        const res = await request.delete(`/api/students/${student._id}`).set(auth(instructor))

        assert.equal(res.status, 200)
        assert.equal(await models.quizAttemptModel.countDocuments({ student: student._id }), 0)
        assert.equal(await models.lessonProgressModel.countDocuments({ student: student._id }), 0)
        assert.equal((await certificates()).length, 1)
        assert.equal((await verify(issued.certificateNumber)).status, 200)
    })

    it('unenrolling deletes the progress and attempts of that enrollment but keeps the certificate', async () => {
        const [issued] = await certificates()
        const res = await request.put(`/api/courses/students/${course._id}`).set(auth(instructor)).send({ studentId: student._id.toString() })

        assert.equal(res.status, 200)
        assert.equal(await models.quizAttemptModel.countDocuments({ student: student._id }), 0)
        assert.equal((await certificates()).length, 1)
        assert.equal((await request.get(`/api/my-certificates/${issued.certificateNumber}`).set(studentHeaders)).status, 200)
    })
})

describe('content deletions that complete a course for people who were waiting', () => {
    it('deleting the only missing lesson issues the certificates that are now due', async () => {
        await completeLesson(lessons[0])
        assert.equal((await certificates()).length, 0)

        const res = await request.delete(`/api/lessons/${lessons[1]._id}`).set(auth(instructor))

        assert.equal(res.status, 200)
        assert.equal((await certificates()).length, 1)
    })

    it('deleting a section does the same', async () => {
        const second = await createSection(course, { title: 'Extra' })

        await createLesson(course, { section: second, title: 'Extra lesson' })
        await finishLessons()
        assert.equal((await certificates()).length, 0)

        assert.equal((await request.delete(`/api/sections/${second._id}`).set(auth(instructor))).status, 200)
        assert.equal((await certificates()).length, 1)
    })

    it('deleting the quiz of students who only had the quiz left issues their certificates', async () => {
        const quiz = await withQuiz({ questions: 2 })

        await finishLessons()
        assert.equal((await certificates()).length, 0)

        assert.equal((await request.delete(`/api/quizzes/${quiz._id}`).set(auth(instructor))).status, 200)
        assert.equal((await certificates()).length, 1)
    })

    it('deleting content that leaves the course empty issues nothing', async () => {
        await request.delete(`/api/lessons/${lessons[0]._id}`).set(auth(instructor))
        await request.delete(`/api/lessons/${lessons[1]._id}`).set(auth(instructor))
        assert.equal((await certificates()).length, 0)
    })
})

describe('public verification', () => {
    let number

    beforeEach(async () => {
        await finishLessons()
        number = (await certificates())[0].certificateNumber
    })

    it('needs no authentication and returns ONLY the fields printed on the certificate', async () => {
        const res = await verify(number)

        assert.equal(res.status, 200)
        assert.deepEqual(Object.keys(res.body.data).sort(), ['certificateNumber', 'courseName', 'instructorName', 'issuedAt', 'studentName', 'valid'])
        assert.equal(res.body.data.valid, true)
        assert.equal(res.body.data.certificateNumber, number)
        assert.equal(res.body.data.studentName, student.name)
        assert.equal(res.body.data.courseName, course.name)
        assert.equal(res.body.data.instructorName, instructor.name)
    })

    it('does not reveal emails, internal ids, scores, attempts or subscription data', async () => {
        const text = JSON.stringify((await verify(number)).body)

        for (const secret of [student.email, instructor.email, String(student._id), String(instructor._id), String(course._id), 'finalScore', 'totalLessons', 'accessStatus', 'attempt']) {
            assert.equal(text.includes(secret), false, secret)
        }
    })

    it('accepts the number in lower case and with surrounding spaces', async () => {
        assert.equal((await verify(number.toLowerCase())).status, 200)
        assert.equal((await verify(encodeURIComponent(` ${number} `))).status, 200)
    })

    it('an unknown or malformed number is the same 404 { valid: false }', async () => {
        for (const bad of ['COH-2026-ZZZZZZZZ', 'COH-2026-ABCDEFGH', 'nonsense', '0'.repeat(30), 'COH-26-ABC']) {
            const res = await verify(bad)

            assert.equal(res.status, 404, bad)
            assert.equal(res.body.valid, false)
            assert.equal(res.body.message, 'Certificate not found')
        }
    })

    it('keeps working when the instructor workspace is not active (verification is public)', async () => {
        await models.transactionModel.deleteMany({})
        await pay(instructor, { paidAt: daysAgo(90) })
        assert.equal((await verify(number)).status, 200)
    })
})

describe('the student own certificates (private)', () => {
    let number

    beforeEach(async () => {
        await finishLessons()
        number = (await certificates())[0].certificateNumber
    })

    it('lists and shows the certificate to its owner, with the printed details', async () => {
        const list = await request.get('/api/my-certificates').set(studentHeaders)
        const one = await request.get(`/api/my-certificates/${number}`).set(studentHeaders)

        assert.equal(list.status, 200)
        assert.equal(list.body.data.length, 1)
        assert.equal(list.body.data[0].certificateNumber, number)
        assert.equal(one.status, 200)
        assert.equal(one.body.data.studentName, student.name)
        assert.equal(one.body.data.courseName, course.name)
        assert.equal(one.body.data.instructorName, instructor.name)
        assert.equal(one.body.data.course, course._id.toString())
        assert.equal(one.body.data.totalLessons, 2)
    })

    it('another student cannot read it (404) and does not see it in their list', async () => {
        const other = await createStudent(instructor)

        assert.equal((await request.get(`/api/my-certificates/${number}`).set(auth(other))).status, 404)
        assert.deepEqual((await request.get('/api/my-certificates').set(auth(other))).body.data, [])
    })

    it('instructors and anonymous callers are refused', async () => {
        assert.equal((await request.get(`/api/my-certificates/${number}`).set(auth(instructor))).status, 403)
        assert.equal((await request.get('/api/my-certificates').set(auth(instructor))).status, 403)
        assert.equal((await request.get(`/api/my-certificates/${number}`)).status, 401)
        assert.equal((await request.get('/api/my-certificates')).status, 401)
    })

    it('stays viewable when the workspace subscription is NOT active (an issued certificate is history, not learning content)', async () => {
        await models.transactionModel.deleteMany({})
        await pay(instructor, { paidAt: daysAgo(90) })

        assert.equal((await request.get(`/api/students-courses/${course._id}`).set(studentHeaders)).status, 403) // learning is blocked...
        assert.equal((await request.get(`/api/my-certificates/${number}`).set(studentHeaders)).status, 200) // ...the certificate is not
        assert.equal((await request.get('/api/my-certificates').set(studentHeaders)).status, 200)
    })

    it('stays viewable after the course is unpublished', async () => {
        await models.courseModel.updateOne({ _id: course._id }, { status: 'draft' })
        assert.equal((await request.get(`/api/my-certificates/${number}`).set(studentHeaders)).status, 200)
    })

    it('rejects a malformed number as 404', async () => {
        assert.equal((await request.get('/api/my-certificates/nope').set(studentHeaders)).status, 404)
    })
})
