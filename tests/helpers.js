import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Environment must be prepared BEFORE the app modules are imported.
export const SERVER_KEY = 'SB-Mid-server-test-key'
const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-test-'))

process.env.NODE_ENV = 'test'
process.env.SECRET_KEY_JWT = 'test-secret-key-at-least-16-chars'
process.env.APP_URL = 'http://api.test'
process.env.FRONTEND_URL = 'http://app.test'
process.env.MIDTRANS_URL = 'https://midtrans.invalid/snap/v1/transactions'
process.env.MIDTRANS_AUTH_STRING = Buffer.from(`${SERVER_KEY}:`).toString('base64')
process.env.PUBLIC_DIR = publicDir

const { default: mongoose } = await import('mongoose')
const { MongoMemoryServer } = await import('mongodb-memory-server')
const { default: supertest } = await import('supertest')
const { default: jwt } = await import('jsonwebtoken')
const { default: bcrypt } = await import('bcrypt')

const { createApp } = await import('../src/app.js')
const { default: userModel } = await import('../src/models/userModel.js')
const { default: courseModel } = await import('../src/models/courseModel.js')
const { default: sectionModel } = await import('../src/models/sectionModel.js')
const { default: lessonModel } = await import('../src/models/lessonModel.js')
const { default: lessonProgressModel } = await import('../src/models/lessonProgressModel.js')
const { default: categoryModel } = await import('../src/models/categoryModel.js')
const { default: transactionModel } = await import('../src/models/transactionModel.js')
const { default: quizModel } = await import('../src/models/quizModel.js')
const { default: quizAttemptModel } = await import('../src/models/quizAttemptModel.js')
const { default: certificateModel } = await import('../src/models/certificateModel.js')
const { default: aiSummaryModel } = await import('../src/models/aiSummaryModel.js')

export const models = {
    userModel, courseModel, sectionModel, lessonModel, lessonProgressModel, categoryModel, transactionModel,
    quizModel, quizAttemptModel, certificateModel, aiSummaryModel,
}
export { publicDir, mongoose }

export const PASSWORD = 'secret-pass-1'

let mongod
let counter = 0

export const startTestEnv = async () => {
    mongod = await MongoMemoryServer.create()
    await mongoose.connect(mongod.getUri())
    await userModel.syncIndexes()
    // build every index (unique ones included) before the first insert
    await Promise.all(Object.values(models).map((model) => model.init()))

    return supertest(createApp())
}

export const stopTestEnv = async () => {
    await mongoose.disconnect()
    await mongod?.stop()
    fs.rmSync(publicDir, { recursive: true, force: true })
}

export const resetDb = async () => {
    await Promise.all(Object.values(models).map((model) => model.deleteMany({})))
    fs.rmSync(path.join(publicDir, 'uploads'), { recursive: true, force: true })
}

export const tokenFor = (user, options = {}) =>
    jwt.sign({ data: { id: user._id.toString() } }, process.env.SECRET_KEY_JWT, {
        algorithm: 'HS256',
        expiresIn: '1 days',
        ...options,
    })

export const auth = (user) => ({ Authorization: `JWT ${tokenFor(user)}` })

const passwordHash = await bcrypt.hash(PASSWORD, 4)

export const createCategory = (name = 'Programming') => categoryModel.create({ name })

// Instructor ("manager" in the database). active=true gives a successful payment.
export const createInstructor = async ({ active = true, email, paidAt } = {}) => {
    counter += 1

    const user = await userModel.create({
        name: `Instructor ${counter}`,
        email: email ?? `instructor${counter}@test.dev`,
        password: passwordHash,
        photo: 'default.png',
        role: 'manager',
    })

    if (active) await pay(user, { paidAt })

    return user
}

export const DAY = 24 * 60 * 60 * 1000
export const daysAgo = (days) => new Date(Date.now() - days * DAY)

// A transaction for the instructor. Defaults to a successful payment made now.
export const pay = (instructor, { paidAt = new Date(), months = 1, status = 'success', purpose = 'activation' } = {}) =>
    transactionModel.create({
        user: instructor._id,
        price: 280000,
        status,
        purpose,
        periodMonths: months,
        paidAt: status === 'success' ? paidAt : undefined,
        // created before it was paid, like a real order
        createdAt: paidAt,
    })

export const mongoUri = () => mongod.getUri()

export const createStudent = async (instructor, { email } = {}) => {
    counter += 1

    return userModel.create({
        name: `Student ${counter}`,
        email: email ?? `student${counter}@test.dev`,
        password: passwordHash,
        photo: 'default.png',
        role: 'student',
        manager: instructor._id,
    })
}

// Courses start as drafts, like the API creates them. Pass { published: true } to publish.
export const createCourse = async (instructor, category, { published = false } = {}) => {
    counter += 1

    const course = await courseModel.create({
        name: `Course number ${counter}`,
        thumbnail: 'thumb.png',
        tagline: 'A tagline',
        description: 'A description long enough',
        category: category._id,
        manager: instructor._id,
        status: published ? 'published' : 'draft',
    })

    await userModel.findByIdAndUpdate(instructor._id, { $push: { courses: course._id } })

    return course
}

export const createSection = async (course, { title = 'Section title', order } = {}) =>
    sectionModel.create({
        course: course._id,
        title,
        order: order ?? (await sectionModel.countDocuments({ course: course._id })),
    })

// A lesson in the given section, or in the course's first section (created if needed).
export const createLesson = async (course, { section, ...overrides } = {}) => {
    const target =
        section ??
        (await sectionModel.findOne({ course: course._id }).sort({ order: 1, _id: 1 })) ??
        (await createSection(course))

    return lessonModel.create({
        title: 'Lesson title',
        type: 'text',
        text: '<p>hello world</p>',
        course: course._id,
        section: target._id,
        order: await lessonModel.countDocuments({ section: target._id }),
        ...overrides,
    })
}

export const complete = (student, lesson) =>
    lessonProgressModel.create({ student: student._id, course: lesson.course, lesson: lesson._id })

export const enroll = async (course, student) => {
    await courseModel.findByIdAndUpdate(course._id, { $addToSet: { students: student._id } })
    await userModel.findByIdAndUpdate(student._id, { $addToSet: { courses: course._id } })
}

// 1x1 transparent PNG
export const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
)

// ---- Midtrans mocking ---------------------------------------------------------

// Replaces global fetch for the duration of a test. Returns the recorded calls.
export const mockFetch = (handler) => {
    const original = globalThis.fetch
    const calls = []

    globalThis.fetch = async (url, options) => {
        const call = { url, options, body: options?.body ? JSON.parse(options.body) : null }
        calls.push(call)

        return handler(call)
    }

    return {
        calls,
        restore: () => {
            globalThis.fetch = original
        },
    }
}

export const midtransOk = (redirectUrl = 'https://pay.test/redirect') => () =>
    new Response(JSON.stringify({ token: 'tok', redirect_url: redirectUrl }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
    })

export const sign = (payload, serverKey = SERVER_KEY) => ({
    ...payload,
    signature_key: crypto
        .createHash('sha512')
        .update(`${payload.order_id}${payload.status_code}${payload.gross_amount}${serverKey}`)
        .digest('hex'),
})

// A realistic Midtrans notification body for a transaction
export const notification = (transaction, overrides = {}) =>
    sign({
        order_id: transaction._id.toString(),
        status_code: '200',
        gross_amount: `${transaction.price}.00`,
        transaction_status: 'settlement',
        ...overrides,
    })

// ---- final quiz fixtures (M8) ---------------------------------------------------------------

// A quiz with `questions` single-answer questions, each with options Right / Wrong / Other (the
// first one is the correct one). Pass { questions: [] } for an empty quiz.
export const createQuiz = async (course, { title = 'Final quiz', passingScore = 70, questions = 3 } = {}) => {
    const items = (Array.isArray(questions) ? questions : Array.from({ length: questions })).map((_, order) => {
        const options = ['Right', 'Wrong', 'Other'].map((text) => ({ _id: new mongoose.Types.ObjectId(), text }))

        return { prompt: `Question ${order + 1}?`, order, options, correctOption: options[0]._id }
    })

    return models.quizModel.create({ course: course._id, title, passingScore, questions: items })
}

// Answers for every question of a quiz: the first `correct` questions get the right option and
// the rest a wrong one.
export const answersFor = (quiz, correct) =>
    [...quiz.questions]
        .sort((a, b) => a.order - b.order)
        .map((question, index) => ({
            questionId: question._id.toString(),
            optionId: (index < correct
                ? question.options.find((o) => String(o._id) === String(question.correctOption))
                : question.options.find((o) => String(o._id) !== String(question.correctOption)))._id.toString(),
        }))

// A question body in the shape the instructor API takes.
export const questionBody = (overrides = {}) => ({
    prompt: 'What is two plus two?',
    options: [
        { text: 'Four', isCorrect: true },
        { text: 'Five', isCorrect: false },
        { text: 'Three', isCorrect: false },
    ],
    ...overrides,
})

export const completeAll = async (student, lessons) => {
    for (const lesson of lessons) await complete(student, lesson)
}
