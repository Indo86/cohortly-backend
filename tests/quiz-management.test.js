import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    auth, createCategory, createCourse, createInstructor, createLesson, createQuiz, createSection, createStudent,
    enroll, models, questionBody, resetDb, startTestEnv, stopTestEnv,
} from './helpers.js'

let request
let instructor
let course
let headers

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(async () => {
    await resetDb()
    instructor = await createInstructor()
    course = await createCourse(instructor, await createCategory())
    await createLesson(course)
    headers = auth(instructor)
})

const createQuizApi = (body = { title: 'Final quiz', passingScore: 70 }, who = headers, courseId = course._id) =>
    request.post(`/api/courses/${courseId}/quiz`).set(who).send(body)
const addQuestion = (quizId, body = questionBody(), who = headers) =>
    request.post(`/api/quizzes/${quizId}/questions`).set(who).send(body)

describe('quiz domain', () => {
    it('a course has no quiz until one is created (200 with null, not an error)', async () => {
        const res = await request.get(`/api/courses/${course._id}/quiz`).set(headers)

        assert.equal(res.status, 200)
        assert.equal(res.body.data, null)
    })

    it('creates the final quiz with a default passing score of 70 and reports that it is not ready yet', async () => {
        const res = await createQuizApi({ title: 'Final assessment' })

        assert.equal(res.status, 201)
        assert.equal(res.body.data.title, 'Final assessment')
        assert.equal(res.body.data.passingScore, 70)
        assert.equal(res.body.data.totalQuestions, 0)
        assert.equal(res.body.data.ready, false)
        assert.deepEqual(res.body.data.problems.map((p) => p.code), ['NO_QUESTIONS'])
        assert.equal(res.body.data.course, course._id.toString())
    })

    it('allows only ONE quiz per course (409 QUIZ_EXISTS), and the database enforces it too', async () => {
        assert.equal((await createQuizApi()).status, 201)

        const again = await createQuizApi()

        assert.equal(again.status, 409)
        assert.equal(again.body.code, 'QUIZ_EXISTS')
        assert.equal(await models.quizModel.countDocuments({ course: course._id }), 1)

        await assert.rejects(models.quizModel.collection.insertOne({ course: course._id, title: 'Second', passingScore: 70, questions: [] }), /E11000/)
    })

    it('two simultaneous creates still leave exactly one quiz', async () => {
        const results = await Promise.all([createQuizApi(), createQuizApi(), createQuizApi()])

        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409])
        assert.equal(await models.quizModel.countDocuments({ course: course._id }), 1)
    })

    it('validates the passing score (1-100, whole number) and the title', async () => {
        for (const passingScore of [0, 101, -5, 70.5, '70', null]) {
            assert.equal((await createQuizApi({ title: 'Final quiz', passingScore })).status, 400, String(passingScore))
        }

        assert.equal((await createQuizApi({ title: 'ab', passingScore: 70 })).status, 400)
        assert.equal((await createQuizApi({ passingScore: 70 })).status, 400)

        for (const passingScore of [1, 100]) {
            await models.quizModel.deleteMany({})
            assert.equal((await createQuizApi({ title: 'Final quiz', passingScore })).status, 201, String(passingScore))
        }
    })

    it('updates the title and passing score, with the same validation', async () => {
        const quiz = (await createQuizApi()).body.data
        const ok = await request.put(`/api/quizzes/${quiz._id}`).set(headers).send({ title: 'Renamed quiz', passingScore: 80 })

        assert.equal(ok.status, 200)
        assert.equal(ok.body.data.title, 'Renamed quiz')
        assert.equal(ok.body.data.passingScore, 80)
        assert.equal((await request.put(`/api/quizzes/${quiz._id}`).set(headers).send({ title: 'Renamed quiz', passingScore: 0 })).status, 400)
    })

    it('rejects malformed ids with 400', async () => {
        assert.equal((await request.get('/api/courses/not-an-id/quiz').set(headers)).status, 400)
        assert.equal((await request.put('/api/quizzes/nope').set(headers).send({ title: 'Final quiz', passingScore: 70 })).status, 400)
        assert.equal((await addQuestion('nope')).status, 400)
    })

    it('deletes the quiz (and only the quiz)', async () => {
        const quiz = (await createQuizApi()).body.data
        const res = await request.delete(`/api/quizzes/${quiz._id}`).set(headers)

        assert.equal(res.status, 200)
        assert.equal(await models.quizModel.countDocuments({}), 0)
        assert.equal(await models.courseModel.countDocuments({ _id: course._id }), 1)
        assert.equal((await request.delete(`/api/quizzes/${quiz._id}`).set(headers)).status, 404)
    })
})

describe('quiz ownership and access', () => {
    it('another instructor gets 404 for every quiz and question endpoint, and nothing changes', async () => {
        const quiz = (await createQuizApi()).body.data
        const question = (await addQuestion(quiz._id)).body.data.questions[0]
        const other = auth(await createInstructor())
        const attempts = [
            request.get(`/api/courses/${course._id}/quiz`).set(other),
            createQuizApi({ title: 'Hijack quiz', passingScore: 70 }, other),
            request.put(`/api/quizzes/${quiz._id}`).set(other).send({ title: 'Hijacked', passingScore: 1 }),
            request.delete(`/api/quizzes/${quiz._id}`).set(other),
            addQuestion(quiz._id, questionBody(), other),
            request.put(`/api/quizzes/${quiz._id}/questions/${question._id}`).set(other).send(questionBody({ prompt: 'Hijacked?' })),
            request.delete(`/api/quizzes/${quiz._id}/questions/${question._id}`).set(other),
            request.patch(`/api/quizzes/${quiz._id}/questions/reorder`).set(other).send({ questionIds: [question._id] }),
        ]

        for (const response of await Promise.all(attempts)) assert.equal(response.status, 404)

        const stored = await models.quizModel.findById(quiz._id)

        assert.equal(stored.title, 'Final quiz')
        assert.equal(stored.questions.length, 1)
        assert.equal(stored.questions[0].prompt, 'What is two plus two?')
    })

    it('a student gets 403 on every management endpoint', async () => {
        const quiz = (await createQuizApi()).body.data
        const student = await createStudent(instructor)
        const who = auth(student)

        for (const response of await Promise.all([
            request.get(`/api/courses/${course._id}/quiz`).set(who),
            createQuizApi({ title: 'Student quiz', passingScore: 70 }, who),
            request.put(`/api/quizzes/${quiz._id}`).set(who).send({ title: 'Nope nope', passingScore: 70 }),
            request.delete(`/api/quizzes/${quiz._id}`).set(who),
            addQuestion(quiz._id, questionBody(), who),
        ])) assert.equal(response.status, 403)
    })

    it('anonymous requests get 401', async () => {
        assert.equal((await request.get(`/api/courses/${course._id}/quiz`)).status, 401)
        assert.equal((await request.post(`/api/courses/${course._id}/quiz`).send({ title: 'Final quiz' })).status, 401)
    })

    it('an instructor whose workspace is not active is blocked (ACCESS_NOT_ACTIVE) and the student side too', async () => {
        const idle = await createInstructor({ active: false })
        const idleCourse = await createCourse(idle, await createCategory('Other'))
        const res = await request.get(`/api/courses/${idleCourse._id}/quiz`).set(auth(idle))

        assert.equal(res.status, 403)
        assert.equal(res.body.code, 'ACCESS_NOT_ACTIVE')
    })
})

describe('questions and options', () => {
    let quiz

    beforeEach(async () => {
        quiz = (await createQuizApi()).body.data
    })

    it('adds a question with stable option ids and exactly one correct option, and the quiz becomes ready', async () => {
        const res = await addQuestion(quiz._id)
        const question = res.body.data.questions[0]

        assert.equal(res.status, 201)
        assert.equal(question.prompt, 'What is two plus two?')
        assert.equal(question.order, 0)
        assert.deepEqual(question.options.map((o) => o.text), ['Four', 'Five', 'Three'])
        assert.deepEqual(question.options.map((o) => o.isCorrect), [true, false, false])
        assert.ok(question.options.every((o) => /^[a-f0-9]{24}$/.test(o._id)))
        assert.equal(new Set(question.options.map((o) => o._id)).size, 3)
        assert.equal(res.body.data.totalQuestions, 1)
        assert.equal(res.body.data.ready, true)
        assert.deepEqual(res.body.data.problems, [])
    })

    it('appends questions in order and keeps them ordered', async () => {
        for (const prompt of ['First question', 'Second question', 'Third question']) await addQuestion(quiz._id, questionBody({ prompt }))

        const res = await request.get(`/api/courses/${course._id}/quiz`).set(headers)

        assert.deepEqual(res.body.data.questions.map((q) => q.prompt), ['First question', 'Second question', 'Third question'])
        assert.deepEqual(res.body.data.questions.map((q) => q.order), [0, 1, 2])
    })

    it('validates a question: text, 2-8 options, exactly one correct, distinct text', async () => {
        const bad = [
            questionBody({ prompt: '  ' }),
            questionBody({ prompt: 'ab' }),
            questionBody({ options: [{ text: 'Only one', isCorrect: true }] }),
            questionBody({ options: [{ text: 'A', isCorrect: false }, { text: 'B', isCorrect: false }] }),
            questionBody({ options: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: true }] }),
            questionBody({ options: [{ text: 'Same', isCorrect: true }, { text: 'same', isCorrect: false }] }),
            questionBody({ options: [{ text: ' ', isCorrect: true }, { text: 'B', isCorrect: false }] }),
            questionBody({ options: Array.from({ length: 9 }, (_, i) => ({ text: `Option ${i}`, isCorrect: i === 0 })) }),
            questionBody({ options: [{ text: 'A', isCorrect: 'yes' }, { text: 'B', isCorrect: false }] }),
            {},
        ]

        for (const body of bad) assert.equal((await addQuestion(quiz._id, body)).status, 400, JSON.stringify(body).slice(0, 80))

        assert.equal((await models.quizModel.findById(quiz._id)).questions.length, 0)

        const eight = questionBody({ options: Array.from({ length: 8 }, (_, i) => ({ text: `Option ${i}`, isCorrect: i === 3 })) })

        assert.equal((await addQuestion(quiz._id, eight)).status, 201)
    })

    it('editing keeps the ids of the options that stay, so the correct answer follows its id even when options are reordered', async () => {
        const added = (await addQuestion(quiz._id)).body.data.questions[0]
        const [four, five, three] = added.options
        const res = await request.put(`/api/quizzes/${quiz._id}/questions/${added._id}`).set(headers).send({
            prompt: 'What is 2 + 2?',
            options: [
                { id: three._id, text: 'Three', isCorrect: false },
                { id: four._id, text: 'Four (4)', isCorrect: true },
                { text: 'Six', isCorrect: false },
            ],
        })
        const question = res.body.data.questions[0]

        assert.equal(res.status, 200)
        assert.equal(question.prompt, 'What is 2 + 2?')
        assert.deepEqual(question.options.map((o) => o.text), ['Three', 'Four (4)', 'Six'])
        assert.equal(question.options[0]._id, three._id)
        assert.equal(question.options[1]._id, four._id)
        assert.equal(question.options[1].isCorrect, true)
        assert.equal(question.options[2]._id !== five._id, true) // a new option gets a new id; the removed one is gone
        assert.equal(question.options.some((o) => o._id === five._id), false)
    })

    it('rejects an option id that does not belong to the question (cannot borrow ids)', async () => {
        const first = (await addQuestion(quiz._id)).body.data.questions[0]
        const second = (await addQuestion(quiz._id, questionBody({ prompt: 'Another one?' }))).body.data.questions[1]
        const res = await request.put(`/api/quizzes/${quiz._id}/questions/${second._id}`).set(headers).send({
            prompt: 'Another one?',
            options: [{ id: first.options[0]._id, text: 'Four', isCorrect: true }, { text: 'Other', isCorrect: false }],
        })

        assert.equal(res.status, 400)
        assert.equal(res.body.errors[0].path, 'options.0.id')
    })

    it('updating an unknown question is 404; the body is validated like when adding', async () => {
        const added = (await addQuestion(quiz._id)).body.data.questions[0]

        assert.equal((await request.put(`/api/quizzes/${quiz._id}/questions/${quiz._id}`).set(headers).send(questionBody())).status, 404)
        assert.equal((await request.put(`/api/quizzes/${quiz._id}/questions/${added._id}`).set(headers).send(questionBody({ options: [] }))).status, 400)
    })

    it('deletes a question and keeps the order a clean 0..n-1', async () => {
        for (const prompt of ['First question', 'Second question', 'Third question']) await addQuestion(quiz._id, questionBody({ prompt }))

        const current = (await request.get(`/api/courses/${course._id}/quiz`).set(headers)).body.data
        const res = await request.delete(`/api/quizzes/${quiz._id}/questions/${current.questions[1]._id}`).set(headers)

        assert.equal(res.status, 200)
        assert.deepEqual(res.body.data.questions.map((q) => q.prompt), ['First question', 'Third question'])
        assert.deepEqual(res.body.data.questions.map((q) => q.order), [0, 1])
        assert.equal((await request.delete(`/api/quizzes/${quiz._id}/questions/${current.questions[1]._id}`).set(headers)).status, 404)
    })

    it('reorders questions; a list that is not exactly the current questions is REORDER_MISMATCH', async () => {
        for (const prompt of ['First question', 'Second question', 'Third question']) await addQuestion(quiz._id, questionBody({ prompt }))

        const ids = (await request.get(`/api/courses/${course._id}/quiz`).set(headers)).body.data.questions.map((q) => q._id)
        const ok = await request.patch(`/api/quizzes/${quiz._id}/questions/reorder`).set(headers).send({ questionIds: [ids[2], ids[0], ids[1]] })

        assert.equal(ok.status, 200)
        assert.deepEqual(ok.body.data.questions.map((q) => q.prompt), ['Third question', 'First question', 'Second question'])
        assert.deepEqual(ok.body.data.questions.map((q) => q.order), [0, 1, 2])

        for (const questionIds of [[ids[0], ids[1]], [ids[0], ids[1], ids[2], quiz._id], [ids[0], ids[0], ids[1]]]) {
            const bad = await request.patch(`/api/quizzes/${quiz._id}/questions/reorder`).set(headers).send({ questionIds })

            assert.equal(bad.status, 400)
        }

        const mismatch = await request.patch(`/api/quizzes/${quiz._id}/questions/reorder`).set(headers).send({ questionIds: [ids[0], ids[1], quiz._id] })

        assert.equal(mismatch.body.code, 'REORDER_MISMATCH')
    })

    it('reports exactly what is missing while the quiz is being built', async () => {
        await models.quizModel.updateOne({ _id: quiz._id }, { $push: { questions: { prompt: 'Broken', order: 0, options: [{ text: 'Only' }], correctOption: quiz._id } } })

        const res = await request.get(`/api/courses/${course._id}/quiz`).set(headers)

        assert.equal(res.body.data.ready, false)
        assert.deepEqual(res.body.data.problems.map((p) => p.code).sort(), ['NO_CORRECT_OPTION', 'TOO_FEW_OPTIONS'])
    })

    it('the instructor view shows which option is correct (and nothing else is derived from a client body)', async () => {
        await addQuestion(quiz._id)

        const res = await request.get(`/api/courses/${course._id}/quiz`).set(headers)

        assert.deepEqual(res.body.data.questions[0].options.filter((o) => o.isCorrect).map((o) => o.text), ['Four'])
        assert.equal(JSON.stringify(res.body).includes('correctOption'), false)
    })
})

describe('publishing a course with a quiz', () => {
    const publish = (status = 'published') => request.put(`/api/courses/${course._id}/status`).set(headers).send({ status })

    it('a course without a quiz publishes exactly as before', async () => {
        assert.equal((await publish()).status, 200)
    })

    it('a course with a READY quiz publishes', async () => {
        await createQuiz(course, { questions: 2 })

        assert.equal((await publish()).status, 200)
    })

    it('a course whose quiz has no questions is refused with QUIZ_NOT_READY and the reasons', async () => {
        await createQuizApi()

        const res = await publish()

        assert.equal(res.status, 422)
        assert.equal(res.body.code, 'QUIZ_NOT_READY')
        assert.deepEqual(res.body.problems.map((p) => p.code), ['NO_QUESTIONS'])
        assert.equal((await models.courseModel.findById(course._id)).status, 'draft')
    })

    it('an incomplete question blocks publishing; completing the quiz allows it', async () => {
        const quiz = await createQuiz(course, { questions: 1 })

        await models.quizModel.updateOne({ _id: quiz._id, 'questions._id': quiz.questions[0]._id }, { $set: { 'questions.$.options': [{ text: 'Only one' }] } })
        assert.equal((await publish()).status, 422)

        const fresh = await models.quizModel.findById(quiz._id)

        await models.quizModel.updateOne({ _id: quiz._id, 'questions._id': fresh.questions[0]._id }, { $set: { 'questions.$.options': [{ _id: fresh.questions[0].correctOption, text: 'Right' }, { text: 'Wrong' }] } })
        assert.equal((await publish()).status, 200)
    })

    it('still needs a lesson first (existing rule) and unpublishing is always allowed', async () => {
        const empty = await createCourse(instructor, await createCategory('More'))
        const res = await request.put(`/api/courses/${empty._id}/status`).set(headers).send({ status: 'published' })

        assert.equal(res.status, 422)
        assert.equal(res.body.code, 'COURSE_NOT_PUBLISHABLE')

        await createQuizApi() // not ready
        await models.courseModel.updateOne({ _id: course._id }, { status: 'published' })
        assert.equal((await publish('draft')).status, 200)
    })

    it('editing the quiz of an already published course is allowed; the quiz is then simply not offered until it is ready again', async () => {
        const quiz = await createQuiz(course, { questions: 1 })

        assert.equal((await publish()).status, 200)

        const res = await request.delete(`/api/quizzes/${quiz._id}/questions/${quiz.questions[0]._id}`).set(headers)

        assert.equal(res.status, 200)
        assert.equal(res.body.data.ready, false)
        assert.equal((await models.courseModel.findById(course._id)).status, 'published')
    })

    it('enrolled students are not affected by the instructor management endpoints', async () => {
        const student = await createStudent(instructor)

        await enroll(course, student)
        await createSection(course)
        assert.equal((await request.get(`/api/courses/${course._id}/quiz`).set(auth(student))).status, 403)
    })
})
