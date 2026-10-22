import bcrypt from 'bcrypt'
import userModel from '../models/userModel.js'
import { deleteStudentCascade } from '../services/cascade.js'
import { mutateStudentSchema, updateStudentSchema } from '../utils/schema.js'
import { userPhotoUrl } from '../utils/photo.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { badRequest, conflict } from '../utils/httpError.js'
import { parseOrThrow } from '../middlewares/validateRequest.js'
import { removeUpload, removeUploadedFile } from '../utils/files.js'
import { ROLES } from '../utils/roles.js'
import { findOwnedStudent } from '../utils/ownership.js'

const BCRYPT_ROUNDS = 12


const cleanupUploadOnError = (handler) =>
    asyncHandler(async (req, res, next) => {
        try {
            return await handler(req, res, next)
        } catch (error) {
            removeUploadedFile(req.file)
            throw error
        }
    })

export const getStudents = asyncHandler(async (req, res) => {
    const students = await userModel
        .find({ role: ROLES.STUDENT, manager: req.user._id })
        .select('name courses photo')

    const response = students.map((item) => ({
        ...item.toObject(),
        photo_url: userPhotoUrl(item.photo),
    }))

    return res.json({
        message: 'Get Students success',
        data: response,
    })
})

export const getStudentById = asyncHandler(async (req, res) => {
    const student = await findOwnedStudent(req.params.id, req.user._id)

    return res.json({
        message: 'Get detail student success',
        data: { _id: student._id, name: student.name, email: student.email, photo_url: userPhotoUrl(student.photo) },
    })
})

export const postStudent = cleanupUploadOnError(async (req, res) => {
    const body = parseOrThrow(mutateStudentSchema, req.body)

    if (!req.file) throw badRequest('Avatar image is required')

    if (await userModel.exists({ email: body.email })) {
        throw conflict('Email is already registered', { code: 'EMAIL_EXISTS' })
    }

    await userModel.create({
        name: body.name,
        email: body.email,
        password: await bcrypt.hash(body.password, BCRYPT_ROUNDS),
        photo: req.file.filename,
        manager: req.user._id,
        role: ROLES.STUDENT,
    })

    return res.json({ message: 'Create student success' })
})

export const updateStudent = cleanupUploadOnError(async (req, res) => {
    const body = parseOrThrow(updateStudentSchema, req.body)

    const student = await findOwnedStudent(req.params.id, req.user._id)

    if (body.email !== student.email) {
        const taken = await userModel.exists({ email: body.email, _id: { $ne: student._id } })

        if (taken) throw conflict('Email is already registered', { code: 'EMAIL_EXISTS' })
    }

    const oldPhoto = student.photo

    student.name = body.name
    student.email = body.email

    // the password changes only when one was explicitly supplied
    if (body.password !== undefined) {
        student.password = await bcrypt.hash(body.password, BCRYPT_ROUNDS)
        // signs the student out everywhere: tokens issued before now are rejected (verifyToken)
        student.passwordChangedAt = new Date()
    }

    if (req.file) student.photo = req.file.filename

    await student.save()

    if (req.file) removeUpload('students', oldPhoto)

    return res.json({ message: 'Update student success' })
})

export const deleteStudent = asyncHandler(async (req, res) => {
    const student = await findOwnedStudent(req.params.id, req.user._id)

    // removes enrollments and every progress record of the student
    await deleteStudentCascade(student)

    removeUpload('students', student.photo)

    return res.json({ message: 'Delete student success' })
})
