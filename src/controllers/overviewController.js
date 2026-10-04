import courseModel from '../models/courseModel.js'
import lessonModel from '../models/lessonModel.js'
import userModel from '../models/userModel.js'
import { getConfig } from '../config/env.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { ROLES } from '../utils/roles.js'

// Instructor dashboard numbers, scoped strictly to the signed-in instructor.
// totalVideos / totalTexts count lessons by type; publishedCourses counts courses
// students can currently learn from.
export const getOverviews = asyncHandler(async (req, res) => {
    const { appUrl } = getConfig()

    const courses = await courseModel
        .find({ manager: req.user._id })
        .select('name thumbnail students status')
        .populate({ path: 'category', select: 'name -_id' })
        .populate({ path: 'students', select: 'name' })

    const courseIds = courses.map((course) => course._id)

    const [totalVideos, totalTexts, students] = await Promise.all([
        lessonModel.countDocuments({ course: { $in: courseIds }, type: 'video' }),
        lessonModel.countDocuments({ course: { $in: courseIds }, type: 'text' }),
        userModel
            .find({ role: ROLES.STUDENT, manager: req.user._id })
            .select('name courses photo'),
    ])

    const totalStudents = courses.reduce((acc, curr) => acc + curr.students.length, 0)

    return res.json({
        message: 'Get overview success',
        data: {
            totalCourses: courses.length,
            publishedCourses: courses.filter((course) => course.status === 'published').length,
            totalStudents,
            totalVideos,
            totalTexts,
            courses: courses.map((item) => ({
                ...item.toObject(),
                thumbnail_url: item.thumbnail ? `${appUrl}/uploads/courses/${item.thumbnail}` : null,
                total_students: item.students.length,
            })),
            students: students.map((item) => ({
                ...item.toObject(),
                photo_url: `${appUrl}/uploads/students/${item.photo}`,
            })),
        },
    })
})
