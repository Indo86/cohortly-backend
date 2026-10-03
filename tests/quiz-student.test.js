import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import {
    answersFor, auth, completeAll, createCategory, createCourse, createInstructor, createLesson, createQuiz, createSection,
    createStudent, enroll, models, resetDb, startTestEnv, stopTestEnv, complete, pay, daysAgo,
} from './helpers.js'

let request
let instructor
let student
let course
let lessons
let quiz
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
    quiz = await createQuiz(course, { questions: 3, passingScore: 70 })
    await enroll(course, student)
    studentHeaders = auth(student)
})

const getQuiz = (who = studentHeaders, courseId = course._id) => request.get(`/api/students-courses/${courseId}/quiz`).set(who)
const submit = (answers, who = studentHeaders, extra = {}, courseId = course._id) =>
    request.post(`/api/students-courses/${courseId}/quiz/attempts`).set(who).send({ answers, ...extra })
const attempts = (who = studentHeaders) => request.get(`/api/students-courses/${course._id}/quiz/attempts`).set(who)
const courseView = async () => (await request.get(`/api/students-courses/${course._id}`).set(studentHeaders)).body.data
const unlock = () => completeAll(student, lessons)

describe('who can open the quiz', () => {
    it('is LOCKED (409 QUIZ_LOCKED) until every lesson is completed, and gives no questions', async () => {
        const res = await getQuiz()

        assert.equal(res.status, 409)
        assert.equal(res.body.code, 'QUIZ_LOCKED')
        assert.equal(JSON.stringify(res.body).includes('Question 1'), false)

        await complete(student, lessons[0])
        assert.equal((await getQuiz()).status, 409)
        await complete(student, lessons[1])
        assert.equal((await getQuiz()).status, 200)
    })

    it('submitting while locked is refused too, and stores nothing', async () => {
        const res = await submit(answersFor(quiz, 3))

        assert.equal(res.status, 409)
        assert.equal(res.body.code, 'QUIZ_LOCKED')
        assert.equal(await models.quizAttemptModel.countDocuments({}), 0)
    })

    it('needs enrollment, a published course and a quiz: all the same safe 404', async () => {
        await unlock()

        const outsider = await createStudent(instructor)

        assert.equal((await getQuiz(auth(outsider))).status, 404)

        await models.courseModel.updateOne({ _id: course._id }, { status: 'draft' })
        assert.equal((await getQuiz()).status, 404)
        await models.courseModel.updateOne({ _id: course._id }, { status: 'published' })

        await models.quizModel.deleteMany({})

        const none = await getQuiz()

        assert.equal(none.status, 404)
        assert.equal(none.body.code, 'QUIZ_NOT_FOUND')
    })

    it('an unfinished quiz is not offered (409 QUIZ_NOT_READY)', async () => {
        await unlock()
        await models.quizModel.updateOne({ _id: quiz._id }, { $set: { questions: [] } })

        const res = await getQuiz()

        assert.equal(res.status, 409)
        assert.equal(res.body.code, 'QUIZ_NOT_READY')
        assert.equal((await submit([{ questionId: lessons[0]._id.toString(), optionId: lessons[0]._id.toString() }])).status, 409)
    })

    it('instructors and anonymous callers cannot use the student quiz endpoints', async () => {
        await unlock()

        for (const who of [auth(instructor), {}]) {
            assert.ok([401, 403].includes((await getQuiz(who)).status))
            assert.ok([401, 403].includes((await submit(answersFor(quiz, 3), who)).status))
        }

        assert.equal(await models.quizAttemptModel.countDocuments({}), 0)
    })

    it('is blocked by the hard entitlement (403 WORKSPACE_ACCESS_INACTIVE) when the workspace is not active, for read, submit and history', async () => {
        await unlock()
        await models.transactionModel.deleteMany({})
        await pay(instructor, { paidAt: daysAgo(90) }) // expired

        for (const res of [await getQuiz(), await submit(answersFor(quiz, 3)), await attempts()]) {
            assert.equal(res.status, 403)
            assert.equal(res.body.code, 'WORKSPACE_ACCESS_INACTIVE')
        }
    })
})

describe('the answer key never reaches a student before submitting', () => {
    it('the quiz read contains ids, text and order only: no correctOption, isCorrect or correctness anywhere', async () => {
        await unlock()

        const res = await getQuiz()
        const text = JSON.stringify(res.body)

        assert.equal(res.status, 200)
        assert.equal(/correct/i.test(text), false)
        assert.deepEqual(Object.keys(res.body.data).sort(), ['_id', 'passingScore', 'questions', 'title', 'totalQuestions'])
        assert.deepEqual(Object.keys(res.body.data.questions[0]).sort(), ['_id', 'options', 'order', 'prompt'])
        assert.deepEqual(Object.keys(res.body.data.questions[0].options[0]).sort(), ['_id', 'text'])
        assert.equal(res.body.data.totalQuestions, 3)
        assert.equal(res.body.data.passingScore, 70)
    })

    it('no student-facing endpoint (course, dashboard, attempts, lesson) carries the key', async () => {
        await unlock()

        const responses = [
            await request.get(`/api/students-courses/${course._id}`).set(studentHeaders),
            await request.get('/api/students-courses').set(studentHeaders),
            await attempts(),
            await request.get(`/api/students-courses/${course._id}/lessons/${lessons[0]._id}`).set(studentHeaders),
        ]

        for (const res of responses) assert.equal(/correctOption|isCorrect/.test(JSON.stringify(res.body)), false)

        const key = quiz.questions[0].correctOption.toString()
        const failed = await submit(answersFor(quiz, 0))

        assert.equal(JSON.stringify(failed.body).includes(key), false) // the result reveals right/wrong, never the right option
    })

    it('the questions come in the instructor order and options keep their authored order', async () => {
        await unlock()

        const res = await getQuiz()

        assert.deepEqual(res.body.data.questions.map((q) => q.prompt), ['Question 1?', 'Question 2?', 'Question 3?'])
        assert.deepEqual(res.body.data.questions[0].options.map((o) => o.text), ['Right', 'Wrong', 'Other'])
    })
})

describe('submitting an attempt', () => {
    beforeEach(unlock)

    it('scores on the backend: floor(correct * 100 / total), equal weight', async () => {
        const cases = [[0, 0], [1, 33], [2, 66], [3, 100]]

        for (const [correct, score] of cases) {
            const res = await submit(answersFor(quiz, correct))

            assert.equal(res.status, 201)
            assert.equal(res.body.data.score, score, `${correct}/3`)
            assert.equal(res.body.data.correctAnswers, correct)
            assert.equal(res.body.data.totalQuestions, 3)
        }
    })

    it('passes exactly AT the passing score and fails just below it', async () => {
        await models.quizModel.updateOne({ _id: quiz._id }, { passingScore: 66 })
        assert.equal((await submit(answersFor(quiz, 2))).body.data.passed, true) // 66 >= 66

        await models.quizModel.updateOne({ _id: quiz._id }, { passingScore: 67 })
        assert.equal((await submit(answersFor(quiz, 2))).body.data.passed, false) // 66 < 67

        await models.quizModel.updateOne({ _id: quiz._id }, { passingScore: 100 })
        assert.equal((await submit(answersFor(quiz, 3))).body.data.passed, true)
        assert.equal((await submit(answersFor(quiz, 2))).body.data.passed, false)
    })

    it('returns the attempt, the score contract, per-question right/wrong, the new completion state and the certificate', async () => {
        const res = await submit(answersFor(quiz, 3))
        const data = res.body.data

        assert.equal(data.passed, true)
        assert.equal(data.passingScore, 70)
        assert.ok(data.attemptNumber === 1 && data._id && data.submittedAt)
        assert.equal(data.courseCompleted, true)
        assert.equal(data.certificateIssued, true)
        assert.match(data.certificate.certificateNumber, /^COH-\d{4}-[A-Z0-9]{8}$/)
        assert.equal(data.progress.completed, true)
        assert.equal(data.progress.percent, 100)
        assert.equal(data.quiz.state, 'passed')
        assert.deepEqual(data.results.map((r) => r.correct), [true, true, true])
        assert.deepEqual(Object.keys(data.results[0]).sort(), ['correct', 'questionId'])
    })

    it('a failing attempt leaves the course incomplete, with lesson percent still 100 (never 99)', async () => {
        const res = await submit(answersFor(quiz, 1))

        assert.equal(res.body.data.passed, false)
        assert.equal(res.body.data.courseCompleted, false)
        assert.equal(res.body.data.certificate, null)
        assert.equal(res.body.data.certificateIssued, false)
        assert.deepEqual(res.body.data.results.map((r) => r.correct), [true, false, false])
        assert.deepEqual(res.body.data.progress, { completedLessons: 2, totalLessons: 2, percent: 100, completed: false })
        assert.equal(res.body.data.nextActivity.type, 'quiz')
        assert.equal(await models.certificateModel.countDocuments({}), 0)
    })

    it('retries are unlimited and every attempt is kept as history, in order', async () => {
        for (const correct of [1, 0, 2, 3, 1]) assert.equal((await submit(answersFor(quiz, correct))).status, 201)

        const history = (await attempts()).body.data

        assert.equal(history.length, 5)
        assert.deepEqual(history.map((a) => a.attemptNumber), [1, 2, 3, 4, 5])
        assert.deepEqual(history.map((a) => a.score), [33, 0, 66, 100, 33])
        assert.deepEqual(history.map((a) => a.passed), [false, false, false, true, false])
        assert.equal(await models.quizAttemptModel.countDocuments({ student: student._id }), 5)
    })

    it('once passed, a later lower score does not take the pass away', async () => {
        await submit(answersFor(quiz, 3))
        await submit(answersFor(quiz, 0))

        const view = await courseView()

        assert.equal(view.progress.completed, true)
        assert.equal(view.quiz.state, 'passed')
        assert.equal(view.quiz.passed, true)
        assert.equal(view.quiz.attempts, 2)
        assert.equal(view.quiz.bestScore, 100)
        assert.equal(view.quiz.latestAttempt.score, 0)
    })

    it('stores a full historical attempt and never edits an old one', async () => {
        await submit(answersFor(quiz, 1))

        const first = await models.quizAttemptModel.findOne({ student: student._id })

        await submit(answersFor(quiz, 3))

        const reloaded = await models.quizAttemptModel.findById(first._id)

        assert.equal(reloaded.score, 33)
        assert.equal(reloaded.passed, false)
        assert.equal(reloaded.passingScore, 70)
        assert.equal(reloaded.answers.length, 3)
        assert.equal(await models.quizAttemptModel.countDocuments({}), 2)
    })

    it('an attempt remembers the passing score of its time, even if the quiz is edited later', async () => {
        await submit(answersFor(quiz, 2))
        await models.quizModel.updateOne({ _id: quiz._id }, { passingScore: 10 })

        const history = (await attempts()).body.data

        assert.equal(history[0].passingScore, 70)
        assert.equal(history[0].passed, false)
    })
})

describe('rejected submissions', () => {
    beforeEach(unlock)

    const reject = async (body, message) => {
        const res = await request.post(`/api/students-courses/${course._id}/quiz/attempts`).set(studentHeaders).send(body)

        assert.equal(res.status, 400, message)
        assert.equal(await models.quizAttemptModel.countDocuments({}), 0, `${message}: nothing stored`)

        return res
    }

    it('requires every question to be answered', async () => {
        const res = await reject({ answers: answersFor(quiz, 3).slice(0, 2) }, 'missing answer')

        assert.equal(res.body.errors[0].code, 'ANSWERS_INCOMPLETE')
        await reject({ answers: [] }, 'no answers')
        await reject({}, 'no body')
    })

    it('rejects a question answered twice', async () => {
        const answers = answersFor(quiz, 3)

        await reject({ answers: [...answers, answers[0]] }, 'duplicate')
        await reject({ answers: [answers[0], answers[0], answers[1]] }, 'duplicate instead of a missing one')
    })

    it('rejects an unknown question and extra questions', async () => {
        const answers = answersFor(quiz, 3)
        const stranger = new mongoose.Types.ObjectId().toString()

        await reject({ answers: [...answers.slice(0, 2), { questionId: stranger, optionId: answers[2].optionId }] }, 'unknown question')
        await reject({ answers: [...answers, { questionId: stranger, optionId: answers[0].optionId }] }, 'extra question')
    })

    it('rejects an option that belongs to a different question', async () => {
        const answers = answersFor(quiz, 3)
        const swapped = [{ ...answers[0], optionId: answers[1].optionId }, answers[1], answers[2]]
        const res = await reject({ answers: swapped }, 'option of another question')

        assert.equal(res.body.errors[0].path, 'answers.0.optionId')
        await reject({ answers: [{ ...answers[0], optionId: new mongoose.Types.ObjectId().toString() }, answers[1], answers[2]] }, 'unknown option')
    })

    it('rejects malformed ids and malformed bodies', async () => {
        const answers = answersFor(quiz, 3)

        await reject({ answers: [{ questionId: 'nope', optionId: answers[0].optionId }, answers[1], answers[2]] }, 'bad question id')
        await reject({ answers: [{ questionId: answers[0].questionId, optionId: 'nope' }, answers[1], answers[2]] }, 'bad option id')
        await reject({ answers: 'all of them' }, 'not an array')
        await reject({ answers: [{ questionId: answers[0].questionId }] }, 'no option')
        await reject({ answers: [null, 1, 'x'] }, 'garbage entries')
    })

    it('rejects a malformed course id', async () => {
        const res = await request.post('/api/students-courses/not-an-id/quiz/attempts').set(studentHeaders).send({ answers: [] })

        assert.equal(res.status, 400)
    })
})

describe('score and pass/fail cannot be forged', () => {
    beforeEach(unlock)

    it('ignores a client-supplied score, passed, correctness and passing score', async () => {
        const res = await submit(answersFor(quiz, 0), studentHeaders, {
            score: 100,
            passed: true,
            correctAnswers: 3,
            totalQuestions: 1,
            passingScore: 1,
            courseCompleted: true,
            student: new mongoose.Types.ObjectId().toString(),
        })

        assert.equal(res.status, 201)
        assert.equal(res.body.data.score, 0)
        assert.equal(res.body.data.passed, false)
        assert.equal(res.body.data.passingScore, 70)
        assert.equal(res.body.data.courseCompleted, false)

        const stored = await models.quizAttemptModel.findOne({})

        assert.equal(stored.score, 0)
        assert.equal(stored.passed, false)
        assert.equal(String(stored.student), String(student._id))
        assert.equal(await models.certificateModel.countDocuments({}), 0)
    })

    it('per-answer correctness sent by the client is ignored', async () => {
        const answers = answersFor(quiz, 0).map((answer) => ({ ...answer, correct: true, isCorrect: true }))
        const res = await submit(answers)

        assert.equal(res.body.data.score, 0)
    })

    it('an instructor cannot submit an attempt for a student', async () => {
        const res = await submit(answersFor(quiz, 3), auth(instructor), { student: student._id.toString() })

        assert.equal(res.status, 403)
        assert.equal(await models.quizAttemptModel.countDocuments({}), 0)
    })
})

describe('attempt privacy', () => {
    it('a student sees only their own attempts', async () => {
        const other = await createStudent(instructor)

        await enroll(course, other)
        await unlock()
        await completeAll(other, lessons)
        await submit(answersFor(quiz, 3))
        await submit(answersFor(quiz, 0), auth(other))
        await submit(answersFor(quiz, 1), auth(other))

        assert.deepEqual((await attempts()).body.data.map((a) => a.score), [100])
        assert.deepEqual((await attempts(auth(other))).body.data.map((a) => a.score), [0, 33])
    })

    it('history needs enrollment in a published course', async () => {
        const outsider = await createStudent(instructor)

        assert.equal((await attempts(auth(outsider))).status, 404)
        assert.deepEqual((await attempts()).body.data, [])
    })

    it('the attempts of a student are not part of another student result or the course view', async () => {
        const other = await createStudent(instructor)

        await enroll(course, other)
        await unlock()
        await submit(answersFor(quiz, 3))

        const view = (await request.get(`/api/students-courses/${course._id}`).set(auth(other))).body.data

        assert.equal(view.quiz.attempts, 0)
        assert.equal(view.quiz.passed, false)
    })
})

describe('course completion (the one rule)', () => {
    it('WITHOUT a quiz: all lessons completed = course completed (existing courses are unaffected)', async () => {
        await models.quizModel.deleteMany({})

        const before = await courseView()

        assert.equal(before.quiz, null)
        assert.equal(before.progress.completed, false)
        assert.equal(before.nextActivity.type, 'lesson')

        // through the real API: the last lesson of a quiz-less course completes it and issues the certificate
        for (const lesson of lessons) assert.equal((await request.put(`/api/lessons/${lesson._id}/completion`).set(studentHeaders)).status, 200)

        const after = await courseView()

        assert.equal(after.progress.completed, true)
        assert.equal(after.nextLesson, null)
        assert.equal(after.nextActivity, null)
        assert.ok(after.certificate)
    })

    it('WITH a quiz: lessons alone do NOT complete the course; the quiz becomes the next activity', async () => {
        await unlock()

        const view = await courseView()

        assert.deepEqual(view.progress, { completedLessons: 2, totalLessons: 2, percent: 100, completed: false })
        assert.equal(view.nextLesson, null)
        assert.equal(view.nextActivity.type, 'quiz')
        assert.equal(view.nextActivity.state, 'available')
        assert.equal(view.quiz.state, 'available')
        assert.equal(view.certificate, null)
    })

    it('quiz summary states: locked -> available -> passed, and not-ready', async () => {
        assert.equal((await courseView()).quiz.state, 'locked')
        await unlock()
        assert.equal((await courseView()).quiz.state, 'available')

        await models.quizModel.updateOne({ _id: quiz._id }, { $set: { questions: [] } })
        assert.equal((await courseView()).quiz.state, 'not-ready')
        assert.equal((await courseView()).progress.completed, false)
    })

    it('a failed quiz keeps the course incomplete; a pass completes it', async () => {
        await unlock()
        await submit(answersFor(quiz, 1))
        assert.equal((await courseView()).progress.completed, false)
        assert.equal((await courseView()).quiz.latestAttempt.passed, false)

        await submit(answersFor(quiz, 3))

        const view = await courseView()

        assert.equal(view.progress.completed, true)
        assert.equal(view.nextActivity, null)
    })

    it('the dashboard carries the same authoritative state per course', async () => {
        await unlock()

        const list = (await request.get('/api/students-courses').set(studentHeaders)).body.data

        assert.equal(list[0].progress.completed, false)
        assert.equal(list[0].nextActivity.type, 'quiz')
        assert.equal(list[0].quiz.totalQuestions, 3)
        assert.equal(list[0].certificate, null)

        await submit(answersFor(quiz, 3))

        const after = (await request.get('/api/students-courses').set(studentHeaders)).body.data

        assert.equal(after[0].progress.completed, true)
        assert.ok(after[0].certificate.certificateNumber)
    })

    it('a lesson added later reopens the lessons part; the passed quiz stays passed', async () => {
        await unlock()
        await submit(answersFor(quiz, 3))
        await createLesson(course, { title: 'Lesson three' })

        const view = await courseView()

        assert.equal(view.progress.completed, false)
        assert.equal(view.nextActivity.type, 'lesson')
        assert.equal(view.quiz.state, 'passed')
        assert.equal((await getQuiz()).status, 409) // locked again until the new lesson is done
    })

    it('removing the quiz from a course makes it a lessons-only course again', async () => {
        await unlock()
        await models.quizModel.deleteMany({})

        assert.equal((await courseView()).progress.completed, true)
    })
})

describe('instructor progress shows the assessment separately', () => {
    it('reports quiz status, attempts, latest and best score, completion and certificate per learner', async () => {
        const second = await createStudent(instructor)
        const third = await createStudent(instructor)

        for (const s of [second, third]) await enroll(course, s)
        await completeAll(student, lessons)
        await completeAll(second, lessons)
        await submit(answersFor(quiz, 1))
        await submit(answersFor(quiz, 2))
        await submit(answersFor(quiz, 3), auth(second))

        const res = await request.get(`/api/courses/${course._id}/progress`).set(auth(instructor))
        const byId = Object.fromEntries(res.body.data.students.map((s) => [s._id, s]))

        assert.equal(res.status, 200)
        assert.deepEqual(res.body.data.quiz, { _id: quiz._id.toString(), title: 'Final quiz', passingScore: 70, totalQuestions: 3, ready: true })
        assert.deepEqual(byId[student._id].quiz, { status: 'failed', attempts: 2, latestScore: 66, bestScore: 66 })
        assert.deepEqual(byId[second._id].quiz, { status: 'passed', attempts: 1, latestScore: 100, bestScore: 100 })
        assert.deepEqual(byId[third._id].quiz, { status: 'not-started', attempts: 0, latestScore: null, bestScore: null })
        assert.deepEqual(byId[student._id].progress, { completedLessons: 2, totalLessons: 2, percent: 100, completed: false })
        assert.equal(byId[second._id].progress.completed, true)
        assert.equal(byId[second._id].certificateIssued, true)
        assert.equal(byId[student._id].certificateIssued, false)
        assert.deepEqual(res.body.data.summary, { enrolledLearners: 3, completedLearners: 1, certificatesIssued: 1 })
    })

    it('a course without a quiz reports quiz: null and the old shape otherwise', async () => {
        await models.quizModel.deleteMany({})
        await completeAll(student, lessons)

        const res = await request.get(`/api/courses/${course._id}/progress`).set(auth(instructor))

        assert.equal(res.body.data.quiz, null)
        assert.equal(res.body.data.students[0].quiz, null)
        assert.equal(res.body.data.students[0].progress.completed, true)
    })

    it('only the owner sees it', async () => {
        const res = await request.get(`/api/courses/${course._id}/progress`).set(auth(await createInstructor()))

        assert.equal(res.status, 404)
    })
})
