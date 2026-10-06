import courseModel from '../models/courseModel.js'
import lessonModel from '../models/lessonModel.js'
import quizModel from '../models/quizModel.js'
import { HttpError } from '../utils/httpError.js'
import { quizProblems } from '../utils/quiz.js'

// Publish eligibility: THE rule, in one place.
//
// A course can be published when
//   1. it has at least one lesson                      (otherwise COURSE_NOT_PUBLISHABLE)
//   2. its final quiz, if it has one, is ready          (otherwise QUIZ_NOT_READY, with the problems)
//
// Invariant for courses that ARE published: the lesson rule must keep holding. An instructor change
// that would leave a published course without any lesson is refused (409 PUBLISHED_COURSE_INVARIANT);
// unpublishing first is the explicit way to empty a course. The quiz rule is deliberately NOT an
// invariant: editing the quiz of a published course is allowed and an unfinished quiz is simply not
// offered to students until it is ready again (see the README, "Quiz availability").

// Pure: the reasons a course with these facts cannot be published, in the order they are reported.
export const publishBlockers = ({ lessonCount, quiz = null }) => {
    const blockers = []

    if (lessonCount < 1) {
        blockers.push({ code: 'COURSE_NOT_PUBLISHABLE', message: 'A course needs at least one lesson before it can be published' })
    }

    const problems = quiz ? quizProblems(quiz) : []

    if (problems.length > 0) {
        blockers.push({ code: 'QUIZ_NOT_READY', message: 'Finish the final quiz before publishing the course', problems })
    }

    return blockers
}

// draft -> published: throws 422 with the first reason the course cannot be published.
export const assertPublishable = async (courseId) => {
    const [lessonCount, quiz] = await Promise.all([
        lessonModel.countDocuments({ course: courseId }),
        quizModel.findOne({ course: courseId }).lean(),
    ])
    const [blocker] = publishBlockers({ lessonCount, quiz })

    if (blocker) {
        const { code, message, problems } = blocker

        throw new HttpError(422, message, { code, ...(problems ? { problems } : {}) })
    }
}

// Before removing `removedLessons` lessons from a course: a PUBLISHED course must keep at least one.
// Drafts can be emptied freely. Call it after the ownership check, so a foreign course stays a 404.
export const assertPublishedCourseKeepsLessons = async (courseId, removedLessons) => {
    // removing nothing (e.g. an empty section) can never break the rule
    if (removedLessons < 1) return

    const course = await courseModel.findById(courseId).select('status').lean()

    if (course?.status !== 'published') return

    const remaining = (await lessonModel.countDocuments({ course: courseId })) - removedLessons
    const [blocker] = publishBlockers({ lessonCount: remaining })

    if (blocker) {
        throw new HttpError(409, 'A published course must keep at least one lesson. Unpublish the course before removing its last lesson.', {
            code: 'PUBLISHED_COURSE_INVARIANT',
            reason: blocker.code,
        })
    }
}
