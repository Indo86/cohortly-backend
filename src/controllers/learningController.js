import courseModel from '../models/courseModel.js'
import lessonModel from '../models/lessonModel.js'
import lessonProgressModel from '../models/lessonProgressModel.js'
import { getConfig } from '../config/env.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { notFound } from '../utils/httpError.js'
import { findLearnableCourse } from '../utils/ownership.js'
import { sanitizeRichText } from '../utils/sanitize.js'
import { byOrder } from '../utils/progress.js'
import { courseProgressForStudent, loadStructure, loadStudentStates } from '../services/learning.js'
import { issueCertificateIfEligible } from '../services/certificates.js'

// Student learning API. Every handler runs behind studentOnly (STUDENT role + ACTIVE
// instructor workspace) and additionally requires the course to be PUBLISHED and the
// student to be ENROLLED (findLearnableCourse). Draft, unenrolled and unknown courses
// are all the same 404.
//
// Everything a student is told about progress comes from services/learning.js
// studentCourseState: lesson progress (`progress.completedLessons/totalLessons/percent`),
// the AUTHORITATIVE course completion (`progress.completed`: all lessons, plus a passed final quiz
// when the course has one), `nextLesson`, `nextActivity`, the `quiz` summary and the `certificate`.

const courseImageUrl = (name) => (name ? `${getConfig().appUrl}/uploads/courses/${name}` : null)

// Dashboard: enrolled, published courses with progress and the next lesson.
// Enrolled courses that are drafts / unpublished are left out of the active learning list.
export const getMyCourses = asyncHandler(async (req, res) => {
    const courses = await courseModel
        .find({ students: req.user._id, status: 'published' })
        .select('name tagline category thumbnail')
        .populate({ path: 'category', select: 'name' })
        .sort({ name: 1, _id: 1 })

    const states = await loadStudentStates(courses.map((course) => course._id), req.user._id)

    return res.json({
        message: 'Get Courses success',
        data: courses.map((course) => ({
            ...course.toObject(),
            thumbnail_url: courseImageUrl(course.thumbnail),
            ...states.get(String(course._id)).state,
        })),
    })
})

// The learning view of one course: ordered sections and lessons with completion state.
// Lesson content is fetched per lesson (getLesson). Sections without lessons are omitted.
export const getMyCourse = asyncHandler(async (req, res) => {
    const found = await findLearnableCourse(req.params.courseId, req.user._id)

    const course = await courseModel
        .findById(found._id)
        .select('name tagline description category thumbnail')
        .populate({ path: 'category', select: 'name' })

    const { entry: structure, completed, state } = (await loadStudentStates([course._id], req.user._id)).get(String(course._id))

    const completedIds = completed?.ids ?? new Set()

    const sections = [...structure.sections]
        .sort(byOrder)
        .map((section) => {
            const lessons = structure.lessons
                .filter((lesson) => String(lesson.section) === String(section._id))
                .sort(byOrder)
                .map((lesson) => ({
                    _id: lesson._id,
                    title: lesson.title,
                    type: lesson.type,
                    order: lesson.order,
                    completed: completedIds.has(String(lesson._id)),
                }))

            return {
                _id: section._id,
                title: section.title,
                order: section.order,
                lessons,
                completedLessons: lessons.filter((lesson) => lesson.completed).length,
                totalLessons: lessons.length,
            }
        })
        .filter((section) => section.totalLessons > 0)

    return res.json({
        message: 'Get Course Detail success',
        data: {
            ...course.toObject(),
            thumbnail_url: courseImageUrl(course.thumbnail),
            sections,
            ...state,
            lastActivityAt: completed?.lastAt ?? null,
        },
    })
})

// One lesson with its content, completion state and previous/next navigation.
export const getLesson = asyncHandler(async (req, res) => {
    const course = await findLearnableCourse(req.params.courseId, req.user._id)

    const lesson = await lessonModel.findOne({ _id: req.params.lessonId, course: course._id })

    if (!lesson) throw notFound('Lesson not found')

    const structure = (await loadStructure([course._id])).get(String(course._id))
    const completion = await lessonProgressModel.findOne({ student: req.user._id, lesson: lesson._id })

    const position = structure.ordered.findIndex((item) => String(item._id) === String(lesson._id))

    return res.json({
        message: 'Get lesson success',
        data: {
            _id: lesson._id,
            title: lesson.title,
            type: lesson.type,
            order: lesson.order,
            text: sanitizeRichText(lesson.text),
            youtubeId: lesson.youtubeId,
            sectionId: lesson.section,
            sectionTitle: structure.sectionTitles.get(String(lesson.section)) ?? null,
            completed: Boolean(completion),
            completedAt: completion?.completedAt ?? null,
            previousLessonId: structure.ordered[position - 1]?._id ?? null,
            nextLessonId: structure.ordered[position + 1]?._id ?? null,
        },
    })
})

// Resolves the lesson of a completion request and checks enrollment + publication.
const learnableLesson = async (lessonId, studentId) => {
    const lesson = await lessonModel.findById(lessonId)

    if (!lesson) throw notFound('Lesson not found')

    // the lesson's own course decides, never anything the client sends
    await findLearnableCourse(lesson.course, studentId)

    return lesson
}

const completionResponse = async (lesson, studentId, completion) => ({
    lessonId: lesson._id,
    completed: Boolean(completion),
    completedAt: completion?.completedAt ?? null,
    ...(await courseProgressForStudent(lesson.course, studentId)),
})

// PUT is state-setting and idempotent: completing an already completed lesson changes
// nothing and returns the current state. The unique (student, lesson) index plus an
// upsert guarantee a single record even under concurrent requests.
//
// Completing the LAST lesson of a course WITHOUT a final quiz completes the course, which issues
// the certificate (idempotent, services/certificates.js). With a quiz the course is not complete
// until the quiz is passed, so nothing is issued here.
export const completeLesson = asyncHandler(async (req, res) => {
    const lesson = await learnableLesson(req.params.lessonId, req.user._id)
    const key = { student: req.user._id, lesson: lesson._id }
    const insert = { $setOnInsert: { ...key, course: lesson.course, completedAt: new Date() } }

    let completion

    try {
        completion = await lessonProgressModel.findOneAndUpdate(key, insert, { upsert: true, new: true })
    } catch (error) {
        if (error?.code !== 11000) throw error

        // a concurrent request created it between the lookup and the insert
        completion = await lessonProgressModel.findOne(key)
    }

    const { issued } = await issueCertificateIfEligible(lesson.course, req.user._id)

    return res.json({
        message: 'Lesson marked as completed',
        data: { ...(await completionResponse(lesson, req.user._id, completion)), certificateIssued: issued },
    })
})

// DELETE reverses the completion. Idempotent: removing an absent completion succeeds
// and returns the current (not completed) state. An already issued certificate is NOT revoked:
// it records that the course was completed at that time.
export const undoLessonCompletion = asyncHandler(async (req, res) => {
    const lesson = await learnableLesson(req.params.lessonId, req.user._id)

    await lessonProgressModel.deleteOne({ student: req.user._id, lesson: lesson._id })

    return res.json({
        message: 'Lesson completion removed',
        data: await completionResponse(lesson, req.user._id, null),
    })
})
