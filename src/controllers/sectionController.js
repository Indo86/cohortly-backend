import sectionModel from '../models/sectionModel.js'
import lessonModel from '../models/lessonModel.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { findOwnedCourse, findOwnedSection } from '../utils/ownership.js'
import { buildOutline, nextOrder, reorderChildren } from '../services/structure.js'
import { deleteSectionCascade } from '../services/cascade.js'
import { reconcileCourseCertificates } from '../services/certificates.js'
import { assertPublishedCourseKeepsLessons } from '../services/publishing.js'

// All handlers run behind instructorOnly (INSTRUCTOR role + ACTIVE workspace);
// ownership is checked through the course.

export const listSections = asyncHandler(async (req, res) => {
    const course = await findOwnedCourse(req.params.courseId, req.user._id)

    return res.json({
        message: 'Get sections success',
        data: await buildOutline(course._id),
    })
})

export const createSection = asyncHandler(async (req, res) => {
    const course = await findOwnedCourse(req.params.courseId, req.user._id)

    const section = await sectionModel.create({
        course: course._id,
        title: req.body.title,
        order: await nextOrder(sectionModel, { course: course._id }),
    })

    return res.status(201).json({
        message: 'Create section success',
        data: { _id: section._id, title: section.title, order: section.order, lessons: [] },
    })
})

export const updateSection = asyncHandler(async (req, res) => {
    const section = await findOwnedSection(req.params.sectionId, req.user._id)

    section.title = req.body.title
    await section.save()

    return res.json({
        message: 'Update section success',
        data: { _id: section._id, title: section.title, order: section.order },
    })
})

// Deleting a section deletes its lessons and their progress records. A section that holds the last
// lessons of a PUBLISHED course cannot be deleted (409 PUBLISHED_COURSE_INVARIANT): unpublish first.
export const deleteSectionAction = asyncHandler(async (req, res) => {
    const section = await findOwnedSection(req.params.sectionId, req.user._id)

    await assertPublishedCourseKeepsLessons(section.course, await lessonModel.countDocuments({ section: section._id }))
    await deleteSectionCascade(section)
    // removing lessons can complete the course for students who had finished the rest
    await reconcileCourseCertificates(section.course)

    return res.json({ message: 'Delete section success' })
})

export const reorderSections = asyncHandler(async (req, res) => {
    const course = await findOwnedCourse(req.params.courseId, req.user._id)

    await reorderChildren(sectionModel, { course: course._id }, req.body.sectionIds, 'sectionIds')

    return res.json({
        message: 'Reorder sections success',
        data: await buildOutline(course._id),
    })
})
