import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import userModel from '../models/userModel.js'
import { getConfig } from '../config/env.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { conflict, unauthorized } from '../utils/httpError.js'
import { ROLES } from '../utils/roles.js'
import { getEntitlementForUser } from '../services/entitlement.js'
import { startCheckout } from '../services/payments.js'

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

    const token = jwt.sign(
        { data: { id: existingUser._id.toString() } },
        getConfig().jwtSecret,
        { algorithm: 'HS256', expiresIn: '1 days' }
    )

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
            role: req.user.role,
            ...(await getEntitlementForUser(req.user)),
        },
    })
})
