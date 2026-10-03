import mongoose from "mongoose";

// A cached AI lesson summary. This is the ONLY AI data Cohortly stores, and it is derived from the lesson
// text alone: it contains no student, no question and no personal data, so one summary can safely serve
// every student of the lesson. Student questions, answers, practice questions and quiz drafts are NOT stored.
//
// Cache key: lesson + sourceHash (a hash of the course/section/lesson titles and the text that was sent) +
// provider + model. Editing the lesson changes the hash, so a stale summary is simply never found again
// (and is deleted when the new one is stored). Deleting a lesson/section/course deletes its summaries.
const aiSummaryModel = new mongoose.Schema({
    lesson: {type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', required: true},
    course: {type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true},
    sourceHash: {type: String, required: true},
    provider: {type: String, required: true},
    model: {type: String, required: true},
    summary: {type: String, required: true},
    generatedAt: {type: Date, required: true, default: Date.now}
})

aiSummaryModel.index({lesson: 1, sourceHash: 1, provider: 1, model: 1}, {unique: true})
aiSummaryModel.index({course: 1})

export default mongoose.model('AiSummary', aiSummaryModel)
