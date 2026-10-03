import mongoose from "mongoose";

// The final quiz of a course. A course has at most ONE quiz (unique index on `course`).
//
// Questions and options are EMBEDDED, not separate collections: a quiz is small (tens of
// questions), is always read and written as a unit, never queried by question, and an
// embedded document is updated atomically with its parent. Every question and option keeps
// a stable ObjectId (`_id`), so students answer with ids that survive reordering and editing
// of the other items; array positions are never used as identifiers.
//
// The correct answer is stored on the question as `correctOption` (an option _id), which makes
// "exactly one correct option" true by construction. It is NEVER sent to students before they
// submit an attempt (see utils/quiz.js presenters).
const optionSchema = new mongoose.Schema({
    text: {type: String, required: true, trim: true}
})

const questionSchema = new mongoose.Schema({
    prompt: {type: String, required: true, trim: true},
    // explicit position among the quiz questions (0..n-1); ties broken by _id
    order: {type: Number, required: true, default: 0},
    options: [optionSchema],
    correctOption: {type: mongoose.Schema.Types.ObjectId, required: true}
})

const quizModel = new mongoose.Schema({
    course: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Course',
        required: true
    },
    title: {type: String, required: true, trim: true},
    // percentage a student's score must reach (>=) to pass
    passingScore: {type: Number, required: true, default: 70, min: 1, max: 100},
    questions: [questionSchema]
}, {timestamps: true})

// one final quiz per course, enforced by the database as well as by the controller
quizModel.index({course: 1}, {unique: true})

export default mongoose.model('Quiz', quizModel)
