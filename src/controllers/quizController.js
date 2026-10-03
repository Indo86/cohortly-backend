import mongoose from 'mongoose'
import quizModel from '../models/quizModel.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { badRequest, conflict, notFound } from '../utils/httpError.js'
import { findOwnedCourse, findOwnedQuiz } from '../utils/ownership.js'
import { orderedQuestions, presentQuizForInstructor } from '../utils/quiz.js'
import { reconcileCourseCertificates } from '../services/certificates.js'

// Instructor management of a course's single final quiz. Every handler runs behind
// instructorOnly (INSTRUCTOR role + ACTIVE workspace); ownership always comes from the course
// (Course.manager), never from the ids in the URL or body. A quiz or question of someone else is
// a 404. The correct answer is visible here (the editor needs it) and ONLY here.

const present = (quiz) => presentQuizForInstructor(quiz)

// 200 with data: null when the course has no quiz yet (that is a normal state, not an error)
export const getCourseQuiz = asyncHandler(async (req, res) => {
    const course = await findOwnedCourse(req.params.courseId, req.user._id)
    const quiz = await quizModel.findOne({ course: course._id })

    return res.json({ message: 'Get quiz success', data: quiz ? present(quiz) : null })
})

export const createQuiz = asyncHandler(async (req, res) => {
    const course = await findOwnedCourse(req.params.courseId, req.user._id)

    try {
        const quiz = await quizModel.create({
            course: course._id,
            title: req.body.title,
            passingScore: req.body.passingScore,
            questions: [],
        })

        return res.status(201).json({ message: 'Create quiz success', data: present(quiz) })
    } catch (error) {
        // the unique index on `course` also covers two simultaneous requests
        if (error?.code === 11000) {
            throw conflict('This course already has a final quiz', { code: 'QUIZ_EXISTS' })
        }

        throw error
    }
})

// Title and passing score only. Existing attempts and certificates stay as they are.
export const updateQuiz = asyncHandler(async (req, res) => {
    const quiz = await findOwnedQuiz(req.params.quizId, req.user._id)

    quiz.title = req.body.title
    quiz.passingScore = req.body.passingScore
    await quiz.save()

    return res.json({ message: 'Update quiz success', data: present(quiz) })
})

// Deleting the quiz removes the final assessment from the course (the quiz and its questions go).
// Policy: attempts are kept as history, certificates are never touched. Students who were only
// waiting for the quiz are now complete by the rule, so their certificates are issued.
export const deleteQuiz = asyncHandler(async (req, res) => {
    const quiz = await findOwnedQuiz(req.params.quizId, req.user._id)

    await quizModel.deleteOne({ _id: quiz._id })
    await reconcileCourseCertificates(quiz.course)

    return res.json({ message: 'Delete quiz success' })
})

// ---- questions ---------------------------------------------------------------------------

const findQuestion = (quiz, questionId) => {
    const question = quiz.questions.id(questionId)

    if (!question) throw notFound('Question not found')

    return question
}

// Turns the editor's options into stored options. An option that carries an id must already
// belong to THIS question (so ids cannot be borrowed from another question or quiz) and keeps
// that id; an option without one gets a new stable id. The flagged option becomes correctOption.
const buildOptions = (input, existingOptions = []) => {
    const known = new Set(existingOptions.map((option) => String(option._id)))
    const errors = []
    const options = input.map((option, index) => {
        if (option.id && !known.has(String(option.id))) {
            errors.push({ path: `options.${index}.id`, message: 'This option does not belong to the question.' })
        }

        return { _id: option.id ? new mongoose.Types.ObjectId(option.id) : new mongoose.Types.ObjectId(), text: option.text, isCorrect: option.isCorrect }
    })

    if (errors.length > 0) throw badRequest('Validation error', { errors })

    return {
        options: options.map(({ _id, text }) => ({ _id, text })),
        correctOption: options.find((option) => option.isCorrect)._id,
    }
}

export const addQuestion = asyncHandler(async (req, res) => {
    const quiz = await findOwnedQuiz(req.params.quizId, req.user._id)
    const { options, correctOption } = buildOptions(req.body.options)
    const last = orderedQuestions(quiz).at(-1)

    quiz.questions.push({ prompt: req.body.prompt, order: last ? last.order + 1 : 0, options, correctOption })
    await quiz.save()

    return res.status(201).json({ message: 'Add question success', data: present(quiz) })
})

export const updateQuestion = asyncHandler(async (req, res) => {
    const quiz = await findOwnedQuiz(req.params.quizId, req.user._id)
    const question = findQuestion(quiz, req.params.questionId)
    const { options, correctOption } = buildOptions(req.body.options, question.options)

    question.prompt = req.body.prompt
    question.options = options
    question.correctOption = correctOption
    await quiz.save()

    return res.json({ message: 'Update question success', data: present(quiz) })
})

export const deleteQuestion = asyncHandler(async (req, res) => {
    const quiz = await findOwnedQuiz(req.params.quizId, req.user._id)
    const question = findQuestion(quiz, req.params.questionId)

    question.deleteOne()

    // keep the explicit order a clean 0..n-1
    orderedQuestions(quiz).forEach((item, position) => {
        item.order = position
    })
    await quiz.save()

    return res.json({ message: 'Delete question success', data: present(quiz) })
})

// The body must list every question exactly once; the order becomes the given order.
export const reorderQuestions = asyncHandler(async (req, res) => {
    const quiz = await findOwnedQuiz(req.params.quizId, req.user._id)
    const requested = req.body.questionIds.map(String)
    const current = new Set(quiz.questions.map((question) => String(question._id)))

    if (requested.length !== current.size || !requested.every((id) => current.has(id))) {
        throw badRequest('questionIds must list every question exactly once', { code: 'REORDER_MISMATCH' })
    }

    requested.forEach((id, position) => {
        quiz.questions.id(id).order = position
    })
    await quiz.save()

    return res.json({ message: 'Reorder questions success', data: present(quiz) })
})
