import quizModel from '../models/quizModel.js'
import quizAttemptModel from '../models/quizAttemptModel.js'
import lessonProgressModel from '../models/lessonProgressModel.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { conflict, notFound } from '../utils/httpError.js'
import { findLearnableCourse } from '../utils/ownership.js'
import { allLessonsCompleted } from '../utils/progress.js'
import { assertValidAnswers, isQuizReady, presentQuizForStudent, scoreAttempt } from '../utils/quiz.js'
import { courseProgressForStudent, loadStructure } from '../services/learning.js'
import { issueCertificateIfEligible } from '../services/certificates.js'

// Student side of the final quiz. All handlers run behind studentOnly (STUDENT role + ACTIVE
// instructor workspace); the course must also be PUBLISHED and the student ENROLLED
// (findLearnableCourse: anything else is the same 404). The student never receives an answer
// key; score, pass/fail and completion are computed here and nowhere else.

// Resolves the quiz a student may work on right now, or throws the safe business error.
//   404 (no code)           the course (or its quiz) is not available to this student
//   409 QUIZ_NOT_READY      the instructor has not finished the quiz yet
//   409 QUIZ_LOCKED         not every lesson is completed yet
const openQuiz = async (courseId, studentId) => {
    const course = await findLearnableCourse(courseId, studentId)
    const quiz = await quizModel.findOne({ course: course._id })

    if (!quiz) throw notFound('This course has no final quiz', { code: 'QUIZ_NOT_FOUND' })

    if (!isQuizReady(quiz)) {
        throw conflict('The final quiz is not available yet.', { code: 'QUIZ_NOT_READY' })
    }

    const entry = (await loadStructure([course._id])).get(String(course._id))
    const completed = await lessonProgressModel.find({ student: studentId, course: course._id }).distinct('lesson')

    if (!allLessonsCompleted(entry.ordered, new Set(completed.map(String)))) {
        throw conflict('Complete all lessons to unlock the final quiz.', { code: 'QUIZ_LOCKED' })
    }

    return { course, quiz }
}

// The quiz to answer: questions and options only.
export const getStudentQuiz = asyncHandler(async (req, res) => {
    const { quiz } = await openQuiz(req.params.courseId, req.user._id)

    return res.json({ message: 'Get quiz success', data: presentQuizForStudent(quiz) })
})

const presentAttempt = (attempt, attemptNumber) => ({
    _id: attempt._id,
    attemptNumber,
    score: attempt.score,
    passingScore: attempt.passingScore,
    correctAnswers: attempt.correctAnswers,
    totalQuestions: attempt.totalQuestions,
    passed: attempt.passed,
    submittedAt: attempt.submittedAt,
})

export const submitQuizAttempt = asyncHandler(async (req, res) => {
    const { course, quiz } = await openQuiz(req.params.courseId, req.user._id)

    // every question answered exactly once, with an option of that question
    assertValidAnswers(quiz, req.body.answers)

    // the client sent ONLY choices; correctness, score and pass/fail are decided here
    const result = scoreAttempt(quiz, req.body.answers)
    const attempt = await quizAttemptModel.create({
        quiz: quiz._id,
        course: course._id,
        student: req.user._id,
        answers: result.answers,
        totalQuestions: result.totalQuestions,
        correctAnswers: result.correctAnswers,
        score: result.score,
        passingScore: quiz.passingScore,
        passed: result.passed,
    })
    const attemptNumber = await quizAttemptModel.countDocuments({ quiz: quiz._id, student: req.user._id })

    // a pass can complete the course: issue the certificate now (idempotent)
    const { issued } = await issueCertificateIfEligible(course._id, req.user._id)
    const state = await courseProgressForStudent(course._id, req.user._id)

    return res.status(201).json({
        message: result.passed ? 'Quiz passed' : 'Quiz submitted',
        data: {
            ...presentAttempt(attempt, attemptNumber),
            // right/wrong per question, revealed only after submitting; the correct option itself is not
            results: result.answers.map((item) => ({ questionId: item.question, correct: item.correct })),
            courseCompleted: state.progress.completed,
            certificateIssued: issued,
            ...state,
        },
    })
})

// The student's OWN attempts of this course's quiz, oldest first (Attempt 1, Attempt 2, ...).
export const getQuizAttempts = asyncHandler(async (req, res) => {
    const course = await findLearnableCourse(req.params.courseId, req.user._id)
    const quiz = await quizModel.findOne({ course: course._id }).select('_id')

    const attempts = quiz
        ? await quizAttemptModel.find({ quiz: quiz._id, student: req.user._id }).sort({ submittedAt: 1, _id: 1 })
        : []

    return res.json({
        message: 'Get quiz attempts success',
        data: attempts.map((attempt, index) => presentAttempt(attempt, index + 1)),
    })
})
