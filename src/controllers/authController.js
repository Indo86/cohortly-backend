import bcrypt from 'bcrypt'
import userModel from '../models/userModel.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { badRequest, conflict, unauthorized } from '../utils/httpError.js'
import { signSessionToken } from '../utils/authToken.js'
import { ROLES } from '../utils/roles.js'
import { getEntitlementForUser } from '../services/entitlement.js'
import { startCheckout } from '../services/payments.js'
import { removeUpload, removeUploadedFile } from '../utils/files.js'
import { AVATAR_FOLDER, userPhotoUrl } from '../utils/photo.js'

const BCRYPT_ROUNDS = 12

// Used to spend comparable time when the email is unknown, so response time does
// not reveal whether an account exists.
let dummyHash
const getDummyHash = () => (dummyHash ??= bcrypt.hash('not-a-real-password', BCRYPT_ROUNDS))

// Instructor registration: creates the account and a pending payment.
// Authentication and payment are independent: the account exists as soon as it
// is created; access (workspace entitlement) becomes ACTIVE only through a
// verified Midtrans notification.
export const signUpAction = asyncHandler(async (req, res) => {
    const { name, email, password } = req.body

    if (await userModel.exists({ email })) {
        throw conflict('Email is already registered', { code: 'EMAIL_EXISTS' })
    }

    const user = new userModel({
        name,
        email,
        photo: 'default.png',
        password: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role: ROLES.INSTRUCTOR,
    })

    // the unique index closes the race between the check above and the insert
    await user.save()

    try {
        const { paymentUrl } = await startCheckout(user, 'activation')

        return res.json({
            message: 'Sign Up Success',
            data: {
                midtrans_payment_url: paymentUrl,
            },
        })
    } catch (error) {
        // compensation: the account was created in this very request and has no
        // payment history, so remove it to let the user simply try again
        await userModel.deleteOne({ _id: user._id })
        throw error
    }
})

export const signInAction = asyncHandler(async (req, res) => {
    const { email, password } = req.body

    const existingUser = await userModel.findOne({ email })

    const passwordMatches = await bcrypt.compare(
        password,
        existingUser ? existingUser.password : await getDummyHash()
    )

    if (!existingUser || !passwordMatches) {
        throw unauthorized('Email / password incorrect')
    }

    const token = signSessionToken(existingUser)

    // Credentials are valid at this point. Entitlement is reported, never enforced
    // here, so an expired or unpaid workspace can still sign in and be routed to
    // an "access inactive" / "renew" screen.
    const entitlement = await getEntitlementForUser({
        _id: existingUser._id.toString(),
        role: existingUser.role,
        manager: existingUser.manager ? existingUser.manager.toString() : null,
    })

    return res.json({
        message: 'User Logged in success',
        data: {
            name: existingUser.name,
            email: existingUser.email,
            photo_url: userPhotoUrl(existingUser.photo),
            token,
            role: existingUser.role,
            ...entitlement,
        },
    })
})

// Identity plus entitlement. Instructors see their own workspace entitlement,
// students the entitlement of their instructor's workspace.
export const getMe = asyncHandler(async (req, res) => {
    return res.json({
        message: 'Get current user success',
        data: {
            name: req.user.name,
            email: req.user.email,
            photo_url: userPhotoUrl(req.user.photo),
            role: req.user.role,
            ...(await getEntitlementForUser(req.user)),
        },
    })
})

// PUT /api/me/avatar (multipart, field "avatar"): the signed-in user, instructor or student, replaces
// THEIR OWN avatar. The account comes from the token only. The previous file is removed once the new
// one is saved; a failed request leaves nothing behind.
export const updateAvatar = asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Avatar image is required')

    try {
        const user = await userModel.findById(req.user._id)

        if (!user) throw unauthorized('Invalid or expired token')

        const oldPhoto = user.photo

        user.photo = req.file.filename
        await user.save()

        removeUpload(AVATAR_FOLDER, oldPhoto)

        return res.json({
            message: 'Avatar updated',
            data: { photo_url: userPhotoUrl(user.photo) },
        })
    } catch (error) {
        removeUploadedFile(req.file)
        throw error
    }
})

// PUT /api/me/password { currentPassword, newPassword }: the signed-in user changes THEIR OWN password.
// The account comes from the token only (there is no user id in the request, so this can never become
// a way to reset somebody else's password). The current password must be right; the new one follows
// the password policy (utils/schema.js) and must differ from it. On success every existing token,
// including the one used for this request, stops working: the client signs in again.
export const changePassword = asyncHandler(async (req, res) => {
    const user = await userModel.findById(req.user._id)

    if (!user) throw unauthorized('Invalid or expired token')

    if (!(await bcrypt.compare(req.body.currentPassword, user.password))) {
        throw badRequest('Current password is incorrect.', {
            code: 'CURRENT_PASSWORD_INCORRECT',
            errors: [{ path: 'currentPassword', message: 'Current password is incorrect.' }],
        })
    }

    user.password = await bcrypt.hash(req.body.newPassword, BCRYPT_ROUNDS)
    user.passwordChangedAt = new Date()
    await user.save()

    return res.json({ message: 'Password changed. Please sign in again.' })
})
