import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import userModel from '../models/userModel.js'
import { getConfig } from '../config/env.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { unauthorized } from '../utils/httpError.js'
import { matchesCurrentCredentials } from '../utils/authToken.js'

// Authorization: JWT <token>
// Every failure is a controlled 401; jsonwebtoken's internal messages are never exposed.
export const verifyToken = asyncHandler(async (req, res, next) => {
    const header = req.headers.authorization

    if (typeof header !== 'string') throw unauthorized('Authentication required')

    const parts = header.split(' ')

    if (parts.length !== 2 || parts[0] !== 'JWT' || !parts[1]) {
        throw unauthorized('Authentication required')
    }

    const { jwtSecret } = getConfig()

    if (!jwtSecret) throw new Error('SECRET_KEY_JWT is not configured')

    let decoded

    try {
        decoded = jwt.verify(parts[1], jwtSecret, { algorithms: ['HS256'] })
    } catch {
        throw unauthorized('Invalid or expired token')
    }

    const userId = decoded?.data?.id

    if (!userId || !mongoose.isValidObjectId(userId)) {
        throw unauthorized('Invalid or expired token')
    }

    // every token this API issues carries iat and exp; one without an expiry would never expire, so
    // neither is optional
    if (!Number.isInteger(decoded.iat) || !Number.isInteger(decoded.exp)) {
        throw unauthorized('Invalid or expired token')
    }

    const user = await userModel.findById(userId, '_id name email photo role manager passwordChangedAt')

    if (!user) throw unauthorized('Invalid or expired token')

    // Credential invalidation: a token issued before the latest password change is no longer valid
    // (utils/authToken.js matchesCurrentCredentials). A deleted account is the 401 above; the role always
    // comes from the stored account, never from the token.
    if (!matchesCurrentCredentials(decoded, user)) throw unauthorized('Invalid or expired token')

    req.user = {
        _id: user._id.toString(),
        name: user.name,
        email: user.email,
        photo: user.photo,
        role: user.role,
        // owning instructor (students only); the source of a student's entitlement
        manager: user.manager ? user.manager.toString() : null,
    }

    next()
})
