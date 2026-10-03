import certificateModel from '../models/certificateModel.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { notFound } from '../utils/httpError.js'
import { CERTIFICATE_NUMBER_PATTERN } from '../utils/certificateNumber.js'

// ---- the student's own certificates (private) -------------------------------------------
// Behind verifyToken + STUDENT role only: NO ACTIVE-workspace requirement. A certificate is an
// already-issued historical record, not learning content, so a student can still open it when
// the instructor's subscription has lapsed (and after the course was unpublished or deleted).

const normalize = (value) => String(value ?? '').trim().toUpperCase()

const presentOwn = (certificate) => ({
    certificateNumber: certificate.certificateNumber,
    studentName: certificate.studentName,
    courseName: certificate.courseName,
    instructorName: certificate.instructorName,
    totalLessons: certificate.totalLessons,
    finalScore: certificate.finalScore,
    issuedAt: certificate.issuedAt,
    course: certificate.course,
})

export const getMyCertificates = asyncHandler(async (req, res) => {
    const certificates = await certificateModel.find({ student: req.user._id }).sort({ issuedAt: -1, _id: -1 }).lean()

    return res.json({ message: 'Get certificates success', data: certificates.map(presentOwn) })
})

// Somebody else's certificate, and an unknown number, are the same 404.
export const getMyCertificate = asyncHandler(async (req, res) => {
    const number = normalize(req.params.certificateNumber)
    const certificate = CERTIFICATE_NUMBER_PATTERN.test(number)
        ? await certificateModel.findOne({ certificateNumber: number, student: req.user._id }).lean()
        : null

    if (!certificate) throw notFound('Certificate not found')

    return res.json({ message: 'Get certificate success', data: presentOwn(certificate) })
})

// ---- public verification ------------------------------------------------------------------
// Anyone holding a certificate number can check it. ONLY the fields printed on the certificate
// are returned: no email, no student or instructor id, no course id, no attempts, no
// subscription or score information. Unknown and malformed numbers are the same 404.
export const verifyCertificate = asyncHandler(async (req, res) => {
    const number = normalize(req.params.certificateNumber)
    const certificate = CERTIFICATE_NUMBER_PATTERN.test(number)
        ? await certificateModel.findOne({ certificateNumber: number }).lean()
        : null

    if (!certificate) throw notFound('Certificate not found', { valid: false })

    return res.json({
        message: 'Certificate is valid',
        data: {
            valid: true,
            certificateNumber: certificate.certificateNumber,
            studentName: certificate.studentName,
            courseName: certificate.courseName,
            instructorName: certificate.instructorName,
            issuedAt: certificate.issuedAt,
        },
    })
})
