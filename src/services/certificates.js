import courseModel from '../models/courseModel.js'
import userModel from '../models/userModel.js'
import certificateModel from '../models/certificateModel.js'
import quizAttemptModel from '../models/quizAttemptModel.js'
import { generateCertificateNumber } from '../utils/certificateNumber.js'
import { loadStudentStates } from './learning.js'

// Certificate issuance. The rules, in one place:
//  - A certificate is issued exactly when a student is course-COMPLETE by the one completion
//    rule (utils/progress.js summarizeProgress: all lessons, plus a passed final quiz when the
//    course has one). Nothing here re-implements that rule: it reads studentCourseState.
//  - IDEMPOTENT: one certificate per (student, course), enforced by a unique index. Repeated or
//    concurrent calls cannot create a second one: the loser of a race hits the duplicate-key
//    error and simply returns the winner's certificate.
//  - Issued certificates are HISTORY: never recomputed, never revoked (see models/certificateModel.js).
const MAX_NUMBER_ATTEMPTS = 6

const isDuplicateKey = (error) => error?.code === 11000

// Returns { certificate, issued, eligible }:
//   certificate  the student's certificate for the course (new or existing) or null
//   issued       true only when THIS call created it
//   eligible     the student currently satisfies the completion rule
// `issuedAt` overrides the timestamp (backfill only); `dryRun` reports without writing.
export const issueCertificateIfEligible = async (courseId, studentId, { issuedAt, dryRun = false } = {}) => {
    const existing = await certificateModel.findOne({ student: studentId, course: courseId }).lean()

    if (existing) return { certificate: existing, issued: false, eligible: true }

    const { state, quiz } = (await loadStudentStates([courseId], studentId)).get(String(courseId))

    if (!state.progress.completed) return { certificate: null, issued: false, eligible: false }

    if (dryRun) return { certificate: null, issued: false, eligible: true }

    const [course, student] = await Promise.all([
        courseModel.findById(courseId).select('name manager').lean(),
        userModel.findById(studentId).select('name').lean(),
    ])

    if (!course || !student) return { certificate: null, issued: false, eligible: false }

    const instructor = course.manager ? await userModel.findById(course.manager).select('name').lean() : null
    const snapshot = {
        student: studentId,
        course: courseId,
        studentName: student.name,
        courseName: course.name,
        instructorName: instructor?.name ?? 'Instructor',
        totalLessons: state.progress.totalLessons,
        finalScore: quiz ? state.quiz.bestScore : null,
        issuedAt: issuedAt ?? new Date(),
    }

    for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt += 1) {
        try {
            const created = await certificateModel.create({ ...snapshot, certificateNumber: generateCertificateNumber(snapshot.issuedAt) })

            return { certificate: created.toObject(), issued: true, eligible: true }
        } catch (error) {
            if (!isDuplicateKey(error)) throw error

            // either another request issued this student's certificate first (return it) or the
            // random number collided with another certificate (try a new number)
            const winner = await certificateModel.findOne({ student: studentId, course: courseId }).lean()

            if (winner) return { certificate: winner, issued: false, eligible: true }
        }
    }

    throw new Error('Could not allocate a unique certificate number')
}

// After an instructor change that can make students complete without any action of their own
// (deleting a lesson, a section or the quiz), issue the certificates that are now due.
export const reconcileCourseCertificates = async (courseId) => {
    const course = await courseModel.findById(courseId).select('students').lean()

    for (const studentId of course?.students ?? []) await issueCertificateIfEligible(courseId, studentId)
}

// ---- backfill (scripts/backfill-certificates.js) ------------------------------------------

// Issues certificates for students who ALREADY satisfy the completion rule today and have none.
// Never runs by itself. Idempotent, because it goes through issueCertificateIfEligible.
//
// issuedAt policy: the moment the last requirement was met = the later of the student's most
// recent lesson completion and (for a course with a quiz) their first passing attempt. Limits:
// lesson progress records only reflect the present (a lesson that was undone and completed again
// moves the date), so the date is a defensible reconstruction, not a historical fact.
export const backfillCertificates = async ({ dryRun = false, log = () => {} } = {}) => {
    const report = { courses: 0, students: 0, alreadyCertified: 0, eligible: 0, issued: 0 }
    const courses = await courseModel.find().select('name students').lean()

    for (const course of courses) {
        report.courses += 1

        for (const studentId of course.students ?? []) {
            report.students += 1

            const states = await loadStudentStates([course._id], studentId)
            const { state, completed, quiz } = states.get(String(course._id))

            if (state.certificate) {
                report.alreadyCertified += 1

                continue
            }

            if (!state.progress.completed) continue

            report.eligible += 1

            let issuedAt = completed?.lastAt ?? new Date()

            if (quiz) {
                const firstPass = await quizAttemptModel
                    .findOne({ quiz: quiz._id, student: studentId, passed: true })
                    .sort({ submittedAt: 1 })
                    .select('submittedAt')
                    .lean()

                if (firstPass && firstPass.submittedAt > issuedAt) issuedAt = firstPass.submittedAt
            }

            log(` - ${dryRun ? 'would issue' : 'issuing'}: course "${course.name}", student ${studentId}, issuedAt ${new Date(issuedAt).toISOString()}`)

            const result = await issueCertificateIfEligible(course._id, studentId, { issuedAt, dryRun })

            if (result.issued) report.issued += 1
        }
    }

    return report
}
