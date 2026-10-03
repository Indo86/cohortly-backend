import courseModel from '../models/courseModel.js'
import categoryModel from '../models/categoryModel.js'
import sectionModel from '../models/sectionModel.js'
import lessonModel from '../models/lessonModel.js'
import lessonProgressModel from '../models/lessonProgressModel.js'
import quizModel from '../models/quizModel.js'
import quizAttemptModel from '../models/quizAttemptModel.js'
import aiSummaryModel from '../models/aiSummaryModel.js'
import userModel from '../models/userModel.js'

// HISTORICAL RECORDS (decided in M8): issued CERTIFICATES are never deleted by any cascade below.
// They carry snapshots of the names (certificateModel.js), so they stay valid and verifiable after
// the course, the lesson structure, the quiz or even the student account is gone.
// QUIZ ATTEMPTS are learning data like lesson progress: deleted with their course, student or
// enrollment; but when only the QUIZ is deleted they are kept as history (they are keyed by the
// quiz id, so a new quiz never inherits them).
//
// Explicit cascades so no orphan section, lesson or progress record is left behind.
// (No multi-document transactions on a standalone MongoDB: each function deletes
// children first and the parent last, so a crash can leave a parent without some
// children's cleanup but never orphaned children of a missing parent; re-running the
// delete finishes the cleanup.)

export const deleteLessonCascade = async (lesson) => {
    await lessonProgressModel.deleteMany({ lesson: lesson._id })
    await aiSummaryModel.deleteMany({ lesson: lesson._id })
    await lessonModel.deleteOne({ _id: lesson._id })
}

export const deleteSectionCascade = async (section) => {
    const lessonIds = await lessonModel.find({ section: section._id }).distinct('_id')

    await lessonProgressModel.deleteMany({ lesson: { $in: lessonIds } })
    await aiSummaryModel.deleteMany({ lesson: { $in: lessonIds } })
    await lessonModel.deleteMany({ section: section._id })
    await sectionModel.deleteOne({ _id: section._id })
}

export const deleteCourseCascade = async (course) => {
    await lessonProgressModel.deleteMany({ course: course._id })
    await aiSummaryModel.deleteMany({ course: course._id })
    await quizAttemptModel.deleteMany({ course: course._id })
    await quizModel.deleteMany({ course: course._id })
    await lessonModel.deleteMany({ course: course._id })
    await sectionModel.deleteMany({ course: course._id })
    await categoryModel.updateOne({ _id: course.category }, { $pull: { courses: course._id } })
    // enrolled students and the owning instructor all reference the course
    await userModel.updateMany({ courses: course._id }, { $pull: { courses: course._id } })
    await courseModel.deleteOne({ _id: course._id })
}

export const deleteStudentCascade = async (student) => {
    await lessonProgressModel.deleteMany({ student: student._id })
    await quizAttemptModel.deleteMany({ student: student._id })
    await courseModel.updateMany({ students: student._id }, { $pull: { students: student._id } })
    await userModel.deleteOne({ _id: student._id })
}

// Policy: progress belongs to the enrollment. Unenrolling deletes the student's lesson
// progress and quiz attempts for that course; re-enrolling starts from zero. An issued
// certificate is kept.
export const unenrollStudent = async (course, student) => {
    await lessonProgressModel.deleteMany({ student: student._id, course: course._id })
    await quizAttemptModel.deleteMany({ student: student._id, course: course._id })
    await userModel.updateOne({ _id: student._id }, { $pull: { courses: course._id } })
    await courseModel.updateOne({ _id: course._id }, { $pull: { students: student._id } })
}
