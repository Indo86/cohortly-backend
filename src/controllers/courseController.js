import courseModel from '../models/courseModel.js'
import categoryModel from '../models/categoryModel.js'
import userModel from '../models/userModel.js'
import lessonModel from '../models/lessonModel.js'
import quizModel from '../models/quizModel.js'
import { mutateCourseSchema } from '../utils/schema.js'
import { getConfig } from '../config/env.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { HttpError, badRequest } from '../utils/httpError.js'
import { parseOrThrow } from '../middlewares/validateRequest.js'
import { removeUpload, removeUploadedFile } from '../utils/files.js'
import { findOwnedCourse, findOwnedStudent } from '../utils/ownership.js'
import { quizProblems } from '../utils/quiz.js'
import { buildOutline } from '../services/structure.js'
import { deleteCourseCascade, unenrollStudent } from '../services/cascade.js'

const courseImageUrl = (name) => (name ? `${getConfig().appUrl}/uploads/courses/${name}` : null)
const studentPhotoUrl = (name) => `${getConfig().appUrl}/uploads/students/${name}`

// Runs a handler body and removes the just-uploaded file if the request fails afterwards.
const cleanupUploadOnError = (handler) =>
    asyncHandler(async (req, res, next) => {
        try {
            return await handler(req, res, next)
        } catch (error) {
            removeUploadedFile(req.file)
            throw error
        }
    })

export const getCourses = asyncHandler(async (req, res) => {
    const courses = await courseModel
        .find({ manager: req.user._id })
        .select('name thumbnail status')
        .populate({ path: 'category', select: 'name -_id' })
        .populate({ path: 'students', select: 'name' })

    const response = courses.map((item) => ({
        ...item.toObject(),
        thumbnail_url: courseImageUrl(item.thumbnail),
        total_students: item.students.length,
    }))

    return res.json({
        message: 'Get Courses Success',
        data: response,
    })
})

export const getCategories = asyncHandler(async (req, res) => {
    const categories = await categoryModel.find().select('name')

    return res.json({
        message: 'Get categories success',
        data: categories,
    })
})

// Instructor management view of an owned course (draft or published): the course plus
// its ordered sections and lessons. Lesson content is returned only with ?preview=true.
// Students use the learning endpoints (controllers/learningController.js) instead.
export const getCourseById = asyncHandler(async (req, res) => {
    const owned = await findOwnedCourse(req.params.id, req.user._id)

    // category keeps its _id so an edit form can pre-select it (the list view omits it)
    const course = await courseModel
        .findById(owned._id)
        .populate({ path: 'category', select: 'name' })

    const sections = await buildOutline(course._id, { withContent: req.query.preview === 'true' })

    return res.json({
        message: 'Get Course Detail success',
        data: {
            ...course.toObject(),
            thumbnail_url: courseImageUrl(course.thumbnail),
            sections,
            total_sections: sections.length,
            total_lessons: sections.reduce((sum, section) => sum + section.lessons.length, 0),
        },
    })
})

export const postCourse = cleanupUploadOnError(async (req, res) => {
    const body = parseOrThrow(mutateCourseSchema, req.body)

    const category = await categoryModel.findById(body.categoryId)

    if (!category) throw badRequest('Category not found')

    // status is not accepted from the client: every course starts as a draft
    const course = new courseModel({
        name: body.name,
        category: category._id,
        description: body.description,
        tagline: body.tagline,
        thumbnail: req.file?.filename ?? '',
        manager: req.user._id,
        status: 'draft',
    })

    await course.save()

    await categoryModel.findByIdAndUpdate(category._id, { $push: { courses: course._id } })
    await userModel.findByIdAndUpdate(req.user._id, { $push: { courses: course._id } })

    // the id lets a client open the new course straight away
    return res.json({ message: 'Create Course Success', data: { _id: course._id } })
})

export const updateCourse = cleanupUploadOnError(async (req, res) => {
    const body = parseOrThrow(mutateCourseSchema, req.body)

    const course = await findOwnedCourse(req.params.id, req.user._id)

    const category = await categoryModel.findById(body.categoryId)

    if (!category) throw badRequest('Category not found')

    const oldThumbnail = course.thumbnail
    const oldCategoryId = course.category

    course.name = body.name
    course.category = category._id
    course.description = body.description
    course.tagline = body.tagline

    if (req.file) course.thumbnail = req.file.filename

    await course.save()

    if (req.file) removeUpload('courses', oldThumbnail)

    if (String(oldCategoryId) !== String(category._id)) {
        await categoryModel.findByIdAndUpdate(oldCategoryId, { $pull: { courses: course._id } })
        await categoryModel.findByIdAndUpdate(category._id, { $addToSet: { courses: course._id } })
    }

    return res.json({ message: 'Update Course Success' })
})

// Publish rules: the course must contain at least one lesson (which implies a section), and if it
// has a final quiz that quiz must be complete (>= 1 question, each with >= 2 options and one correct
// option, valid passing score), otherwise 422 QUIZ_NOT_READY. A course without a quiz publishes as
// before. Sections without lessons are allowed; students never see them.
// Unpublish is always allowed. It removes student access at once and keeps all progress.
export const updateCourseStatus = asyncHandler(async (req, res) => {
    const course = await findOwnedCourse(req.params.id, req.user._id)
    const { status } = req.body

    if (status === 'published' && course.status !== 'published') {
        if ((await lessonModel.countDocuments({ course: course._id })) < 1) {
            throw new HttpError(422, 'A course needs at least one lesson before it can be published', {
                code: 'COURSE_NOT_PUBLISHABLE',
            })
        }

        const quiz = await quizModel.findOne({ course: course._id })
        const problems = quiz ? quizProblems(quiz) : []

        if (problems.length > 0) {
            throw new HttpError(422, 'Finish the final quiz before publishing the course', {
                code: 'QUIZ_NOT_READY',
                problems,
            })
        }
    }

    course.status = status
    await course.save()

    return res.json({
        message: status === 'published' ? 'Course published' : 'Course unpublished',
        data: { _id: course._id, status: course.status },
    })
})

export const deleteCourse = asyncHandler(async (req, res) => {
    const course = await findOwnedCourse(req.params.id, req.user._id)

    await deleteCourseCascade(course)

    removeUpload('courses', course.thumbnail)

    return res.json({ message: 'Delete course success' })
})

// ---- enrollment -----------------------------------------------------------

export const getStudentsByCourseId = asyncHandler(async (req, res) => {
    const owned = await findOwnedCourse(req.params.id, req.user._id)

    const course = await courseModel
        .findById(owned._id)
        .select('name')
        .populate({ path: 'students', select: 'name email photo' })

    const students = course.students.map((item) => ({
        ...item.toObject(),
        photo_url: studentPhotoUrl(item.photo),
    }))

    return res.json({
        message: 'Get student by course success',
        data: {
            ...course.toObject(),
            students,
        },
    })
})

export const postStudentToCourse = asyncHandler(async (req, res) => {
    const course = await findOwnedCourse(req.params.id, req.user._id)
    const student = await findOwnedStudent(req.body.studentId, req.user._id)

    await userModel.findByIdAndUpdate(student._id, { $addToSet: { courses: course._id } })
    await courseModel.findByIdAndUpdate(course._id, { $addToSet: { students: student._id } })

    return res.json({ message: 'Add Student to course success' })
})

// Unenrolling also deletes the student's progress in that course (progress belongs to
// the enrollment); enrolling again starts from zero.
export const deleteStudentToCourse = asyncHandler(async (req, res) => {
    const course = await findOwnedCourse(req.params.id, req.user._id)
    const student = await findOwnedStudent(req.body.studentId, req.user._id)

    await unenrollStudent(course, student)

    return res.json({ message: 'Delete Student to course success' })
})
