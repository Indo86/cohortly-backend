import { badRequest } from './httpError.js'
import { byOrder } from './progress.js'

// Pure quiz logic (no database): readiness, scoring and the two presenters.
//
// ANSWER-KEY RULE: the only function that may reveal which option is correct is
// presentQuizForInstructor. presentQuizForStudent builds its output from an explicit whitelist
// of fields (it never spreads a document), so `correctOption` cannot leak by accident.

export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 8

export const orderedQuestions = (quiz) => [...quiz.questions].sort(byOrder)

// Why a quiz cannot be offered to students yet. Empty = ready.
export const quizProblems = (quiz) => {
    const problems = []

    if (!Number.isInteger(quiz.passingScore) || quiz.passingScore < 1 || quiz.passingScore > 100) {
        problems.push({ code: 'PASSING_SCORE_INVALID', message: 'The passing score must be a whole number from 1 to 100.' })
    }

    if (quiz.questions.length === 0) {
        problems.push({ code: 'NO_QUESTIONS', message: 'Add at least one question.' })
    }

    orderedQuestions(quiz).forEach((question, index) => {
        const label = `Question ${index + 1}`

        if (!String(question.prompt ?? '').trim()) {
            problems.push({ code: 'QUESTION_EMPTY', questionId: question._id, message: `${label} has no text.` })
        }

        if (question.options.length < MIN_OPTIONS) {
            problems.push({ code: 'TOO_FEW_OPTIONS', questionId: question._id, message: `${label} needs at least ${MIN_OPTIONS} options.` })
        }

        if (!question.options.some((option) => String(option._id) === String(question.correctOption))) {
            problems.push({ code: 'NO_CORRECT_OPTION', questionId: question._id, message: `${label} has no correct option.` })
        }
    })

    return problems
}

export const isQuizReady = (quiz) => quizProblems(quiz).length === 0

// ---- presenters -------------------------------------------------------------------------

// Management view: includes which option is correct (instructor only).
export const presentQuizForInstructor = (quiz) => {
    const problems = quizProblems(quiz)

    return {
        _id: quiz._id,
        course: quiz.course,
        title: quiz.title,
        passingScore: quiz.passingScore,
        totalQuestions: quiz.questions.length,
        ready: problems.length === 0,
        problems,
        createdAt: quiz.createdAt,
        updatedAt: quiz.updatedAt,
        questions: orderedQuestions(quiz).map((question) => ({
            _id: question._id,
            prompt: question.prompt,
            order: question.order,
            options: question.options.map((option) => ({
                _id: option._id,
                text: option.text,
                isCorrect: String(option._id) === String(question.correctOption),
            })),
        })),
    }
}

// Student view: ids, text and order ONLY. No correctness information of any kind.
export const presentQuizForStudent = (quiz) => ({
    _id: quiz._id,
    title: quiz.title,
    passingScore: quiz.passingScore,
    totalQuestions: quiz.questions.length,
    questions: orderedQuestions(quiz).map((question) => ({
        _id: question._id,
        prompt: question.prompt,
        order: question.order,
        options: question.options.map((option) => ({ _id: option._id, text: option.text })),
    })),
})

// ---- attempts ---------------------------------------------------------------------------

// Every question must be answered exactly once, with an option of that very question. Anything
// else (missing, duplicate, unknown question, option of another question) is a 400 with the
// offending positions, so a client cannot craft a partial or inflated submission.
export const assertValidAnswers = (quiz, answers) => {
    const errors = []
    const questions = new Map(quiz.questions.map((question) => [String(question._id), question]))
    const seen = new Set()

    answers.forEach((answer, index) => {
        const question = questions.get(String(answer.questionId))

        if (!question) {
            errors.push({ path: `answers.${index}.questionId`, message: 'This question is not part of the quiz.' })

            return
        }

        if (seen.has(String(question._id))) {
            errors.push({ path: `answers.${index}.questionId`, message: 'This question was answered more than once.' })

            return
        }

        seen.add(String(question._id))

        if (!question.options.some((option) => String(option._id) === String(answer.optionId))) {
            errors.push({ path: `answers.${index}.optionId`, message: 'This option does not belong to the question.' })
        }
    })

    const missing = quiz.questions.filter((question) => !seen.has(String(question._id)))

    if (errors.length === 0 && missing.length > 0) {
        errors.push({ path: 'answers', message: `Answer every question (${missing.length} unanswered).`, code: 'ANSWERS_INCOMPLETE' })
    }

    if (errors.length > 0) throw badRequest('Validation error', { errors })
}

// Equal weight per question. score = floor(correct * 100 / total): an integer 0-100 that is 100
// only when every answer is right (no rounding up to a pass). passed = score >= passingScore.
export const scoreAttempt = (quiz, answers) => {
    const questions = new Map(quiz.questions.map((question) => [String(question._id), question]))
    const graded = answers.map((answer) => ({
        question: answer.questionId,
        option: answer.optionId,
        correct: String(questions.get(String(answer.questionId)).correctOption) === String(answer.optionId),
    }))
    const totalQuestions = quiz.questions.length
    const correctAnswers = graded.filter((item) => item.correct).length
    const score = totalQuestions === 0 ? 0 : Math.floor((correctAnswers * 100) / totalQuestions)

    return { answers: graded, totalQuestions, correctAnswers, score, passed: score >= quiz.passingScore }
}
