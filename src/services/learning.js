import sectionModel from '../models/sectionModel.js'
import lessonModel from '../models/lessonModel.js'
import lessonProgressModel from '../models/lessonProgressModel.js'
import quizModel from '../models/quizModel.js'
import quizAttemptModel from '../models/quizAttemptModel.js'
import certificateModel from '../models/certificateModel.js'
import { allLessonsCompleted, orderLessons, summarizeProgress } from '../utils/progress.js'
import { isQuizReady } from '../utils/quiz.js'

// Loads the structure of several courses at once (2 queries, whatever the count):
// Map(courseId -> { sections, lessons, ordered, sectionTitles })
export const loadStructure = async (courseIds) => {
    const [sections, lessons] = await Promise.all([
        sectionModel.find({ course: { $in: courseIds } }).lean(),
        lessonModel
            .find({ course: { $in: courseIds } })
            .select('course section title type order')
            .lean(),
    ])

    const structure = new Map(
        courseIds.map((id) => [String(id), { sections: [], lessons: [], sectionTitles: new Map() }])
    )

    for (const section of sections) {
        const entry = structure.get(String(section.course))

        entry.sections.push(section)
        entry.sectionTitles.set(String(section._id), section.title)
    }

    for (const lesson of lessons) structure.get(String(lesson.course)).lessons.push(lesson)

    for (const entry of structure.values()) {
        entry.ordered = orderLessons(entry.sections, entry.lessons)
    }

    return structure
}

// Completed lesson ids: Map(courseId -> Map(studentId -> { ids:Set, lastAt:Date }))
export const loadCompletions = async (filter) => {
    const records = await lessonProgressModel.find(filter).select('student course lesson completedAt').lean()
    const byCourse = new Map()

    for (const record of records) {
        const course = String(record.course)
        const student = String(record.student)

        if (!byCourse.has(course)) byCourse.set(course, new Map())

        const students = byCourse.get(course)

        if (!students.has(student)) students.set(student, { ids: new Set(), lastAt: null })

        const entry = students.get(student)

        entry.ids.add(String(record.lesson))
        if (!entry.lastAt || record.completedAt > entry.lastAt) entry.lastAt = record.completedAt
    }

    return byCourse
}

export const nextLessonSummary = (lesson, sectionTitles) =>
    lesson
        ? {
              _id: lesson._id,
              title: lesson.title,
              sectionId: lesson.section,
              sectionTitle: sectionTitles.get(String(lesson.section)) ?? null,
          }
        : null

// ---- assessment (final quiz) data -------------------------------------------------------

// Map(courseId -> quiz) (at most one per course)
export const loadQuizzes = async (courseIds) => {
    const quizzes = await quizModel.find({ course: { $in: courseIds } }).lean()

    return new Map(quizzes.map((quiz) => [String(quiz.course), quiz]))
}

// Attempt statistics: Map(`${quizId}:${studentId}` -> { attempts, passed, bestScore, latest }).
// `passed` is true once ANY attempt passed: a later lower score never takes a pass away.
export const loadAttemptStats = async (quizIds, extraFilter = {}) => {
    if (quizIds.length === 0) return new Map()

    const attempts = await quizAttemptModel
        .find({ quiz: { $in: quizIds }, ...extraFilter })
        .select('quiz student score passed submittedAt')
        .sort({ submittedAt: 1, _id: 1 })
        .lean()
    const stats = new Map()

    for (const attempt of attempts) {
        const key = `${attempt.quiz}:${attempt.student}`
        const entry = stats.get(key) ?? { attempts: 0, passed: false, bestScore: null, latest: null }

        entry.attempts += 1
        entry.passed = entry.passed || attempt.passed
        entry.bestScore = entry.bestScore === null ? attempt.score : Math.max(entry.bestScore, attempt.score)
        entry.latest = { score: attempt.score, passed: attempt.passed, submittedAt: attempt.submittedAt }
        stats.set(key, entry)
    }

    return stats
}

export const certificateSummary = (certificate) =>
    certificate ? { certificateNumber: certificate.certificateNumber, issuedAt: certificate.issuedAt } : null

// What a student sees about the final quiz of a course.
//   state: 'passed'     a passing attempt exists (final: edits to the quiz never revoke it)
//          'not-ready'  the quiz exists but is incomplete, so it cannot be taken yet
//          'locked'     not every lesson is completed yet
//          'available'  can be taken (first attempt or a retry)
export const studentQuizSummary = (quiz, stats, lessonsComplete) => {
    const passed = Boolean(stats?.passed)
    let state = 'available'

    if (passed) state = 'passed'
    else if (!isQuizReady(quiz)) state = 'not-ready'
    else if (!lessonsComplete) state = 'locked'

    return {
        _id: quiz._id,
        title: quiz.title,
        totalQuestions: quiz.questions.length,
        passingScore: quiz.passingScore,
        state,
        passed,
        attempts: stats?.attempts ?? 0,
        latestAttempt: stats?.latest ?? null,
        bestScore: stats?.bestScore ?? null,
    }
}

// Everything the student-facing endpoints say about ONE course for ONE student, derived in one
// place: lesson progress, authoritative completion, the next lesson, the next activity
// (lesson | quiz | nothing), the quiz summary and the certificate summary.
//   progress.completed  authoritative course completion (lessons + quiz rule, utils/progress.js)
//   progress.percent    lesson percentage only
//   nextLesson          unchanged contract: the first incomplete lesson or null
//   nextActivity        { type: 'lesson', ...nextLesson } | { type: 'quiz', quizId, title, state } | null
export const studentCourseState = ({ entry, completedIds = new Set(), quiz = null, stats = null, certificate = null }) => {
    const lessonsComplete = allLessonsCompleted(entry.ordered, completedIds)
    const passed = Boolean(stats?.passed)
    const { progress, nextLesson: nextLessonDoc } = summarizeProgress(entry.ordered, completedIds, {
        quizRequired: Boolean(quiz),
        quizPassed: passed,
    })
    const nextLesson = nextLessonSummary(nextLessonDoc, entry.sectionTitles)
    const quizSummary = quiz ? studentQuizSummary(quiz, stats, lessonsComplete) : null

    let nextActivity = null

    if (nextLesson) nextActivity = { type: 'lesson', ...nextLesson }
    else if (quizSummary && !quizSummary.passed) {
        nextActivity = { type: 'quiz', quizId: quizSummary._id, title: quizSummary.title, state: quizSummary.state }
    }

    return {
        progress,
        nextLesson,
        nextActivity,
        quiz: quizSummary,
        certificate: certificateSummary(certificate),
    }
}

// { progress, nextLesson } for one student in one course, lessons plus (optionally) assessment.
// Kept for callers that only need the lesson-level shape.
export const progressFor = (structureEntry, completedIds = new Set(), assessment = {}) => {
    const { progress, nextLesson } = summarizeProgress(structureEntry.ordered, completedIds, assessment)

    return { progress, nextLesson: nextLessonSummary(nextLesson, structureEntry.sectionTitles) }
}

// The full student-facing state of several courses at once (a constant number of queries):
// Map(courseId -> { entry, completed, quiz, state })
export const loadStudentStates = async (courseIds, studentId) => {
    const structure = await loadStructure(courseIds)
    const completions = await loadCompletions({ student: studentId, course: { $in: courseIds } })
    const quizzes = await loadQuizzes(courseIds)
    const stats = await loadAttemptStats([...quizzes.values()].map((quiz) => quiz._id), { student: studentId })
    const certificates = await certificateModel
        .find({ student: studentId, course: { $in: courseIds } })
        .select('course certificateNumber issuedAt')
        .lean()
    const certificateByCourse = new Map(certificates.map((certificate) => [String(certificate.course), certificate]))

    return new Map(
        courseIds.map((courseId) => {
            const key = String(courseId)
            const entry = structure.get(key)
            const completed = completions.get(key)?.get(String(studentId))
            const quiz = quizzes.get(key) ?? null
            const state = studentCourseState({
                entry,
                completedIds: completed?.ids,
                quiz,
                stats: quiz ? stats.get(`${quiz._id}:${studentId}`) : null,
                certificate: certificateByCourse.get(key) ?? null,
            })

            return [key, { entry, completed, quiz, state }]
        })
    )
}

// Convenience for single-course callers (completion endpoints).
export const courseProgressForStudent = async (courseId, studentId) =>
    (await loadStudentStates([courseId], studentId)).get(String(courseId)).state
