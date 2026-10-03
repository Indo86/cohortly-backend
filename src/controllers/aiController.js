import crypto from 'node:crypto'
import courseModel from '../models/courseModel.js'
import sectionModel from '../models/sectionModel.js'
import lessonModel from '../models/lessonModel.js'
import aiSummaryModel from '../models/aiSummaryModel.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { notFound } from '../utils/httpError.js'
import { findLearnableCourse, findOwnedCourse } from '../utils/ownership.js'
import { byOrder } from '../utils/progress.js'
import { assertAiAvailable, askAboutLesson, generatePracticeQuestions, generateQuizDraft, getAiStatus, summarizeLesson } from '../services/ai/aiService.js'
import { buildCourseContext, buildLessonContext, clientText, MAX_FOCUS_CHARS, MAX_QUESTION_CHARS } from '../services/ai/context.js'

// AI endpoints. They sit behind the SAME guards as the learning/quiz endpoints they belong to
// (STUDENT + ACTIVE workspace + enrolled + published course, or INSTRUCTOR + ACTIVE workspace + owned
// course), so AI can never reach content the caller could not already read. The context sent to the
// provider is built HERE from stored content: course/section/lesson titles and lesson text, plus the
// student's question. It never contains a user name or e-mail, a token, payment data, certificates,
// quiz answer keys, other students or any id. The client cannot supply a system prompt, a provider or a model.

// GET /api/ai/status: configuration only, never calls the provider.
export const getStatus = asyncHandler(async (req, res) => res.json({ message: 'AI status', data: getAiStatus() }))

// The lesson the student may learn from, with the context for the provider.
const lessonContextFor = async (req) => {
    const course = await findLearnableCourse(req.params.courseId, req.user._id)
    const lesson = await lessonModel.findOne({ _id: req.params.lessonId, course: course._id })

    if (!lesson) throw notFound('Lesson not found')

    const section = await sectionModel.findById(lesson.section).select('title').lean()

    assertAiAvailable()

    return { course, lesson, context: buildLessonContext({ course, section, lesson }) }
}

export const askLessonQuestion = asyncHandler(async (req, res) => {
    const { context } = await lessonContextFor(req)
    const question = clientText(req.body.question, MAX_QUESTION_CHARS)
    const data = await askAboutLesson({ userId: req.user._id, context, question })

    return res.json({ message: 'AI answer', data })
})

const sourceHashOf = (context) =>
    crypto
        .createHash('sha256')
        .update([context.courseTitle, context.sectionTitle, context.lessonTitle, context.text].join('\u0000'))
        .digest('hex')

// Summaries are CACHED (shared by all students of the lesson): the free-tier provider has a small daily
// quota and a summary depends only on the lesson. A cache hit costs no quota and bypasses the limiter.
export const summarizeLessonText = asyncHandler(async (req, res) => {
    const { course, lesson, context } = await lessonContextFor(req)
    const { config } = assertAiAvailable()
    const key = { lesson: lesson._id, sourceHash: sourceHashOf(context), provider: config.provider, model: config.model }
    const cached = await aiSummaryModel.findOne(key).lean()

    if (cached) {
        return res.json({ message: 'AI summary', data: { summary: cached.summary, generatedAt: cached.generatedAt, cached: true } })
    }

    const result = await summarizeLesson({ userId: req.user._id, context })

    try {
        await aiSummaryModel.create({ ...key, course: course._id, summary: result.summary, generatedAt: result.generatedAt })
        // older summaries of this lesson belong to text that no longer exists
        await aiSummaryModel.deleteMany({ lesson: lesson._id, sourceHash: { $ne: key.sourceHash } })
    } catch (error) {
        // two students asked at once: the other request stored it first, which is fine
        if (error?.code !== 11000) throw error
    }

    return res.json({ message: 'AI summary', data: { summary: result.summary, generatedAt: result.generatedAt, cached: false } })
})

// Practice questions are for self-study only: not stored, not part of progress, quizzes or certificates.
export const createPracticeQuestions = asyncHandler(async (req, res) => {
    const { context } = await lessonContextFor(req)
    const data = await generatePracticeQuestions({ userId: req.user._id, context })

    return res.json({ message: 'AI practice questions', data })
})

// Instructor: a DRAFT of quiz questions from the OWNED course text. Nothing is created or changed here;
// the instructor reviews the draft and applies it through the normal quiz API (POST /api/quizzes/:id/questions).
export const createQuizDraft = asyncHandler(async (req, res) => {
    const course = await findOwnedCourse(req.params.courseId, req.user._id)

    assertAiAvailable()

    const [sections, lessons] = await Promise.all([
        sectionModel.find({ course: course._id }).lean(),
        lessonModel.find({ course: course._id }).select('section title type order text').lean(),
    ])
    const ordered = [...sections].sort(byOrder)
    const context = buildCourseContext({
        course: await courseModel.findById(course._id).select('name').lean(),
        sections: ordered,
        lessons: ordered.flatMap((section) => lessons.filter((lesson) => String(lesson.section) === String(section._id)).sort(byOrder)),
    })
    const focus = req.body.focus ? clientText(req.body.focus, MAX_FOCUS_CHARS) : ''
    const data = await generateQuizDraft({ userId: req.user._id, context, count: req.body.count, focus })

    return res.json({ message: 'AI quiz draft', data })
})
