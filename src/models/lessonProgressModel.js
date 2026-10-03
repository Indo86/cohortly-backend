import mongoose from "mongoose";

// One record = "this student completed this lesson". It is the ONLY source of
// truth for progress: counts, percentages, completed courses and the next lesson
// are all derived from these records (utils/progress.js). No percentage is stored.
const lessonProgressModel = new mongoose.Schema({
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    course: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Course',
        required: true
    },
    lesson: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lesson',
        required: true
    },
    completedAt: {type: Date, required: true, default: Date.now}
})

// at most one completion per student and lesson (also makes completion idempotent)
lessonProgressModel.index({student: 1, lesson: 1}, {unique: true})
// the student's own course list / course view
lessonProgressModel.index({student: 1, course: 1})
// instructor reporting for one course
lessonProgressModel.index({course: 1})

export default mongoose.model('LessonProgress', lessonProgressModel)
