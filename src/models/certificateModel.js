import mongoose from "mongoose";

// A certificate of completion: an ISSUED, HISTORICAL record. It is created once, when a student
// first completes a course, and is never recalculated or revoked: later changes to the course
// (new lessons, a new quiz) or to names do not touch it.
//
// The names are SNAPSHOTS taken at issuance, so the certificate keeps saying what it said when it
// was issued even if the course is renamed or deleted, or the instructor/student account
// changes. `student` and `course` stay as plain references (they may dangle after a deletion on
// purpose: deleting a course or a student does not delete issued certificates).
const certificateModel = new mongoose.Schema({
    student: {type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true},
    course: {type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true},
    // opaque, human-readable, immutable: COH-2026-XXXXXXXX (utils/certificateNumber.js)
    certificateNumber: {type: String, required: true, immutable: true},
    studentName: {type: String, required: true, immutable: true},
    courseName: {type: String, required: true, immutable: true},
    instructorName: {type: String, required: true, immutable: true},
    // what was true at completion (shown on the certificate, never recomputed)
    totalLessons: {type: Number, required: true, immutable: true},
    finalScore: {type: Number, default: null, immutable: true}, // best passing quiz score, or null (no quiz)
    issuedAt: {type: Date, required: true, immutable: true, default: Date.now}
})

certificateModel.index({certificateNumber: 1}, {unique: true})
// at most one certificate per student and course (also what makes issuance idempotent)
certificateModel.index({student: 1, course: 1}, {unique: true})
// "my certificates", newest first
certificateModel.index({student: 1, issuedAt: -1})

export default mongoose.model('Certificate', certificateModel)
