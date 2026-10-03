import mongoose from "mongoose";

// A lesson belongs to one section of one course. `course` is stored as well so
// ownership, enrollment and progress checks never need to join through sections.
// The successor of the legacy CourseDetail rows (see scripts/migrate-course-content.js).
const lessonModel = new mongoose.Schema({
    course: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Course',
        required: true,
        index: true
    },
    section: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Section',
        required: true
    },
    title: {type: String, required: true},
    type: {
        type: String,
        enum: ['video', 'text'],
        required: true
    },
    // TEXT lessons: sanitized rich text. VIDEO lessons: a YouTube video id.
    text: String,
    youtubeId: String,
    order: {type: Number, required: true, default: 0},
    // set only on lessons created by the legacy migration: makes it idempotent
    legacyDetailId: mongoose.Schema.Types.ObjectId
}, {timestamps: true})

lessonModel.index({section: 1, order: 1})
lessonModel.index(
    {legacyDetailId: 1},
    {unique: true, partialFilterExpression: {legacyDetailId: {$type: 'objectId'}}}
)

export default mongoose.model('Lesson', lessonModel)
