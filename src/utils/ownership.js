import courseModel from '../models/courseModel.js'
import sectionModel from '../models/sectionModel.js'
import lessonModel from '../models/lessonModel.js'
import quizModel from '../models/quizModel.js'
import userModel from '../models/userModel.js'
import { notFound } from './httpError.js'
import { ROLES } from './roles.js'

// Ownership is always derived from stored relations (Course.manager,
// User.manager), never from ids supplied in the request body. A resource that
// exists but belongs to someone else is reported as 404, so ids cannot be probed.

export const findOwnedCourse = async (courseId, instructorId) => {
    const course = await courseModel.findOne({ _id: courseId, manager: instructorId })

    if (!course) throw notFound('Course not found')

    return course
}

export const findOwnedStudent = async (studentId, instructorId) => {
    const student = await userModel.findOne({
        _id: studentId,
        role: ROLES.STUDENT,
        manager: instructorId,
    })

    if (!student) throw notFound('Student not found')

    return student
}

// A section is owned when its course is owned.
export const findOwnedSection = async (sectionId, instructorId) => {
    const section = await sectionModel.findById(sectionId)

    if (!section) throw notFound('Section not found')

    await findOwnedCourse(section.course, instructorId)

    return section
}

// A lesson is owned when its course is owned.
export const findOwnedLesson = async (lessonId, instructorId) => {
    const lesson = await lessonModel.findById(lessonId)

    if (!lesson) throw notFound('Lesson not found')

    await findOwnedCourse(lesson.course, instructorId)

    return lesson
}

// A quiz is owned when its course is owned (the quiz id in the URL never decides ownership).
export const findOwnedQuiz = async (quizId, instructorId) => {
    const quiz = await quizModel.findById(quizId)

    if (!quiz) throw notFound('Quiz not found')

    await findOwnedCourse(quiz.course, instructorId)

    return quiz
}

// A student can learn from a course only if it is published AND they are enrolled.
// Anything else (draft, not enrolled, unknown) is the same 404.
export const findLearnableCourse = async (courseId, studentId) => {
    const course = await courseModel.findOne({
        _id: courseId,
        students: studentId,
        status: 'published',
    })

    if (!course) throw notFound('Course not found')

    return course
}
