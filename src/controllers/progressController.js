import courseModel from '../models/courseModel.js'
import certificateModel from '../models/certificateModel.js'
import { userPhotoUrl } from '../utils/photo.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { findOwnedCourse } from '../utils/ownership.js'
import { isQuizReady } from '../utils/quiz.js'
import { loadAttemptStats, loadCompletions, loadQuizzes, loadStructure, progressFor } from '../services/learning.js'

// Instructor view of learner progress in one OWNED course (draft or published).
// Runs behind instructorOnly (INSTRUCTOR role + ACTIVE workspace). Only students that
// are currently enrolled appear; each row is derived from completion records and, when the
// course has a final quiz, from the students' quiz attempts.
//
// Lesson progress and assessment are reported SEPARATELY and never merged into one number:
//   progress.completedLessons/totalLessons/percent   lessons only
//   progress.completed                               authoritative course completion
//   quiz                                             null (no quiz) | { status, attempts, latestScore, bestScore }
//   certificateIssued                                a certificate exists for this learner and course
export const getCourseProgress = asyncHandler(async (req, res) => {
    const owned = await findOwnedCourse(req.params.courseId, req.user._id)

    const course = await courseModel
        .findById(owned._id)
        .select('name status students')
        .populate({ path: 'students', select: 'name email photo' })

    const entry = (await loadStructure([course._id])).get(String(course._id))
    const completions = (await loadCompletions({ course: course._id })).get(String(course._id))
    const quiz = (await loadQuizzes([course._id])).get(String(course._id)) ?? null
    const stats = quiz ? await loadAttemptStats([quiz._id]) : new Map()
    const certified = new Set(
        (await certificateModel.find({ course: course._id }).select('student').lean()).map((item) => String(item.student))
    )

    const students = [...course.students]
        .sort((a, b) => a.name.localeCompare(b.name) || String(a._id).localeCompare(String(b._id)))
        .map((student) => {
            const completed = completions?.get(String(student._id))
            const attempts = quiz ? stats.get(`${quiz._id}:${student._id}`) : null

            return {
                _id: student._id,
                name: student.name,
                email: student.email,
                photo_url: userPhotoUrl(student.photo),
                ...progressFor(entry, completed?.ids, { quizRequired: Boolean(quiz), quizPassed: Boolean(attempts?.passed) }),
                lastActivityAt: completed?.lastAt ?? null,
                quiz: quiz
                    ? {
                          status: attempts?.passed ? 'passed' : attempts ? 'failed' : 'not-started',
                          attempts: attempts?.attempts ?? 0,
                          latestScore: attempts?.latest?.score ?? null,
                          bestScore: attempts?.bestScore ?? null,
                      }
                    : null,
                certificateIssued: certified.has(String(student._id)),
            }
        })

    return res.json({
        message: 'Get course progress success',
        data: {
            course: {
                _id: course._id,
                name: course.name,
                status: course.status,
                totalLessons: entry.ordered.length,
            },
            quiz: quiz
                ? {
                      _id: quiz._id,
                      title: quiz.title,
                      passingScore: quiz.passingScore,
                      totalQuestions: quiz.questions.length,
                      ready: isQuizReady(quiz),
                  }
                : null,
            summary: {
                enrolledLearners: students.length,
                completedLearners: students.filter((student) => student.progress.completed).length,
                certificatesIssued: students.filter((student) => student.certificateIssued).length,
            },
            students,
        },
    })
})
