import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { summarizeProgress } from '../src/utils/progress.js'
import { assertValidAnswers, isQuizReady, presentQuizForInstructor, presentQuizForStudent, quizProblems, scoreAttempt } from '../src/utils/quiz.js'

const id = () => new mongoose.Types.ObjectId()

// a plain-object quiz (no database): `n` questions, options R/W/X, R is correct
const quizOf = (n, passingScore = 70) => ({
    _id: id(),
    passingScore,
    questions: Array.from({ length: n }, (_, order) => {
        const options = ['R', 'W', 'X'].map((text) => ({ _id: id(), text }))

        return { _id: id(), prompt: `Q${order + 1}`, order, options, correctOption: options[0]._id }
    }),
})
const answers = (quiz, correct) =>
    quiz.questions.map((q, i) => ({ questionId: q._id, optionId: (i < correct ? q.options[0] : q.options[1])._id }))

describe('summarizeProgress: the one completion rule', () => {
    const lessons = [{ _id: 'a' }, { _id: 'b' }]
    const all = new Set(['a', 'b'])

    it('without an assessment argument it is exactly the old lessons-only behaviour', () => {
        assert.deepEqual(summarizeProgress(lessons, all).progress, { completedLessons: 2, totalLessons: 2, percent: 100, completed: true })
        assert.equal(summarizeProgress(lessons, new Set(['a'])).progress.completed, false)
        assert.equal(summarizeProgress([], new Set()).progress.completed, false)
    })

    it('quiz required: lessons alone are not enough, a pass completes, percent stays the lesson percent', () => {
        const need = { quizRequired: true, quizPassed: false }
        const done = { quizRequired: true, quizPassed: true }

        assert.deepEqual(summarizeProgress(lessons, all, need).progress, { completedLessons: 2, totalLessons: 2, percent: 100, completed: false })
        assert.equal(summarizeProgress(lessons, all, done).progress.completed, true)
        assert.equal(summarizeProgress(lessons, new Set(['a']), done).progress.completed, false) // a pass without the lessons is not completion
        assert.equal(summarizeProgress(lessons, new Set(['a']), need).progress.percent, 50)
    })

    it('a course with no lessons is never complete, quiz or not', () => {
        assert.equal(summarizeProgress([], new Set(), { quizRequired: true, quizPassed: true }).progress.completed, false)
    })
})

describe('scoring', () => {
    it('floor(correct * 100 / total) with equal weight', () => {
        const quiz = quizOf(3)

        assert.deepEqual([0, 1, 2, 3].map((n) => scoreAttempt(quiz, answers(quiz, n)).score), [0, 33, 66, 100])
        const six = quizOf(6)

        assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((n) => scoreAttempt(six, answers(six, n)).score), [0, 16, 33, 50, 66, 83, 100])
    })

    it('never rounds up to a pass: 100 only when everything is right', () => {
        const quiz = quizOf(7, 100)

        assert.equal(scoreAttempt(quiz, answers(quiz, 6)).score, 85)
        assert.equal(scoreAttempt(quiz, answers(quiz, 6)).passed, false)
        assert.equal(scoreAttempt(quiz, answers(quiz, 7)).passed, true)
    })

    it('passes at the boundary (>=) and fails one below', () => {
        const quiz = quizOf(10, 70)

        assert.equal(scoreAttempt(quiz, answers(quiz, 7)).passed, true) // 70
        assert.equal(scoreAttempt(quiz, answers(quiz, 6)).passed, false) // 60
        const lenient = quizOf(10, 1)

        assert.equal(scoreAttempt(lenient, answers(lenient, 0)).passed, false) // 0 < 1
    })

    it('marks each answer right or wrong from the stored key only', () => {
        const quiz = quizOf(2)
        const result = scoreAttempt(quiz, answers(quiz, 1))

        assert.deepEqual(result.answers.map((a) => a.correct), [true, false])
        assert.equal(result.correctAnswers, 1)
    })
})

describe('readiness', () => {
    it('is ready with questions that each have 2+ options and a correct one', () => {
        assert.equal(isQuizReady(quizOf(2)), true)
    })

    it('lists every problem', () => {
        const quiz = quizOf(3)

        quiz.questions[0].options = [quiz.questions[0].options[0]]
        quiz.questions[1].correctOption = id()
        quiz.questions[2].prompt = ' '
        quiz.passingScore = 0

        assert.deepEqual(quizProblems(quiz).map((p) => p.code).sort(), ['NO_CORRECT_OPTION', 'PASSING_SCORE_INVALID', 'QUESTION_EMPTY', 'TOO_FEW_OPTIONS'])
        assert.deepEqual(quizProblems({ passingScore: 70, questions: [] }).map((p) => p.code), ['NO_QUESTIONS'])
        assert.equal(isQuizReady({ passingScore: 70.5, questions: quizOf(1).questions }), false)
    })
})

describe('presenters', () => {
    it('the student view is a whitelist: no correctness information, whatever the document contains', () => {
        const quiz = quizOf(2)

        quiz.internalNote = 'secret'
        quiz.questions[0].explanation = 'because'

        const text = JSON.stringify(presentQuizForStudent(quiz))

        assert.equal(/correct|secret|because|internalNote/i.test(text), false)
        assert.equal(presentQuizForStudent(quiz).totalQuestions, 2)
    })

    it('the instructor view flags the correct option', () => {
        const quiz = quizOf(1)
        const view = presentQuizForInstructor(quiz)

        assert.deepEqual(view.questions[0].options.map((o) => o.isCorrect), [true, false, false])
        assert.equal(view.ready, true)
    })

    it('orders questions by their explicit order, then id', () => {
        const quiz = quizOf(3)

        quiz.questions[0].order = 2
        quiz.questions[2].order = 0

        assert.deepEqual(presentQuizForStudent(quiz).questions.map((q) => q.prompt), ['Q3', 'Q2', 'Q1'])
    })
})

describe('answer validation', () => {
    it('accepts exactly one valid answer per question', () => {
        const quiz = quizOf(3)

        assert.doesNotThrow(() => assertValidAnswers(quiz, answers(quiz, 2)))
    })

    it('rejects missing, duplicate, unknown and foreign-option answers', () => {
        const quiz = quizOf(2)
        const [a, b] = answers(quiz, 2)

        assert.throws(() => assertValidAnswers(quiz, [a]), (error) => error.status === 400)
        assert.throws(() => assertValidAnswers(quiz, [a, a]), (error) => error.status === 400)
        assert.throws(() => assertValidAnswers(quiz, [a, { questionId: id(), optionId: b.optionId }]), (error) => error.status === 400)
        assert.throws(() => assertValidAnswers(quiz, [a, { questionId: b.questionId, optionId: quiz.questions[0].options[0]._id }]), (error) => error.status === 400)
    })
})
