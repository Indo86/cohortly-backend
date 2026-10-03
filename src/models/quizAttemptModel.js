import mongoose from "mongoose";

// One submitted attempt of a final quiz. Attempts are HISTORY: a retry creates a new record,
// an old one is never edited. Everything in here was computed by the backend; nothing comes from
// the client except which option was chosen for which question.
const quizAttemptModel = new mongoose.Schema({
    quiz: {type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', required: true},
    course: {type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true},
    student: {type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true},
    answers: [{
        _id: false,
        question: {type: mongoose.Schema.Types.ObjectId, required: true},
        option: {type: mongoose.Schema.Types.ObjectId, required: true},
        correct: {type: Boolean, required: true}
    }],
    totalQuestions: {type: Number, required: true},
    correctAnswers: {type: Number, required: true},
    // integer 0-100: floor(correctAnswers * 100 / totalQuestions)
    score: {type: Number, required: true},
    // the quiz's passing score at the moment of submission (the quiz may be edited later)
    passingScore: {type: Number, required: true},
    passed: {type: Boolean, required: true},
    submittedAt: {type: Date, required: true, default: Date.now}
})

// a student's history in one quiz (latest first) and "has this student passed?"
quizAttemptModel.index({student: 1, quiz: 1, submittedAt: -1})
// instructor reporting for one quiz
quizAttemptModel.index({quiz: 1, student: 1})
// cascades by course
quizAttemptModel.index({course: 1})

export default mongoose.model('QuizAttempt', quizAttemptModel)
