import lessonModel from '../models/lessonModel.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { findOwnedLesson, findOwnedSection } from '../utils/ownership.js'
import { sanitizeRichText } from '../utils/sanitize.js'
import { lessonFields, nextOrder, reorderChildren } from '../services/structure.js'
import { deleteLessonCascade } from '../services/cascade.js'
import { reconcileCourseCertificates } from '../services/certificates.js'
import { assertPublishedCourseKeepsLessons } from '../services/publishing.js'

// All handlers run behind instructorOnly (INSTRUCTOR role + ACTIVE workspace);
// ownership is checked through section -> course.

const present = (lesson) => ({
    _id: lesson._id,
    course: lesson.course,
    section: lesson.section,
    title: lesson.title,
    type: lesson.type,
    order: lesson.order,
    text: sanitizeRichText(lesson.text),
    youtubeId: lesson.youtubeId,
})

// The lesson is appended to the end of the section. The course comes from the owned
// section, never from the client.
export const createLesson = asyncHandler(async (req, res) => {
    const section = await findOwnedSection(req.params.sectionId, req.user._id)

    const lesson = await lessonModel.create({
        ...lessonFields(req.body),
        course: section.course,
        section: section._id,
        order: await nextOrder(lessonModel, { section: section._id }),
    })

    return res.status(201).json({ message: 'Create lesson success', data: present(lesson) })
})

export const getLesson = asyncHandler(async (req, res) => {
    const lesson = await findOwnedLesson(req.params.lessonId, req.user._id)

    return res.json({ message: 'Get lesson success', data: present(lesson) })
})

// Updates title/type/content only. Section, course and order cannot be changed here
// (cross-section moves are not supported; use reorder within a section).
export const updateLesson = asyncHandler(async (req, res) => {
    const lesson = await findOwnedLesson(req.params.lessonId, req.user._id)

    Object.assign(lesson, lessonFields(req.body))
    await lesson.save()

    return res.json({ message: 'Update lesson success', data: present(lesson) })
})

// Deleting a lesson deletes every student's completion record for it. The last lesson of a
// PUBLISHED course cannot be deleted (409 PUBLISHED_COURSE_INVARIANT): unpublish first.
export const deleteLessonAction = asyncHandler(async (req, res) => {
    const lesson = await findOwnedLesson(req.params.lessonId, req.user._id)

    await assertPublishedCourseKeepsLessons(lesson.course, 1)
    await deleteLessonCascade(lesson)
    // removing a lesson can complete the course for students who had finished the rest
    await reconcileCourseCertificates(lesson.course)

    return res.json({ message: 'Delete lesson success' })
})

export const reorderLessons = asyncHandler(async (req, res) => {
    const section = await findOwnedSection(req.params.sectionId, req.user._id)

    await reorderChildren(lessonModel, { section: section._id }, req.body.lessonIds, 'lessonIds')

    const lessons = await lessonModel
        .find({ section: section._id })
        .select('title type order')
        .sort({ order: 1, _id: 1 })
        .lean()

    return res.json({ message: 'Reorder lessons success', data: lessons })
})
