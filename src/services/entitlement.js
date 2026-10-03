import mongoose from 'mongoose'
import transactionModel from '../models/transactionModel.js'
import userModel from '../models/userModel.js'
import { ACCESS } from '../utils/accessStatus.js'
import { ROLES } from '../utils/roles.js'
import { resolveAccess } from '../utils/subscriptionPeriod.js'

const EMPTY = Object.freeze({
    accessStatus: ACCESS.NONE,
    accessStartsAt: null,
    accessExpiresAt: null,
})

// Entitlement of one instructor workspace, derived from its payment history.
// Nothing is stored or scheduled: expiry is simply `now >= accessExpiresAt`.
export const getInstructorEntitlement = async (instructorId, now = new Date()) => {
    if (!instructorId || !mongoose.isValidObjectId(instructorId)) return { ...EMPTY }

    const transactions = await transactionModel
        .find({ user: instructorId })
        .select('status createdAt updatedAt paidAt periodMonths')
        .lean()

    return resolveAccess(transactions, now)
}

// The one place that answers "what is this user entitled to?".
//  - INSTRUCTOR: the entitlement of their own workspace.
//  - STUDENT: the entitlement of the instructor who owns them (User.manager).
//    The state is never copied onto the student. A student without a valid
//    instructor (missing, deleted, or not an instructor) gets NONE: fail closed.
export const getEntitlementForUser = async (user, now = new Date()) => {
    if (user.role === ROLES.INSTRUCTOR) {
        return getInstructorEntitlement(user._id, now)
    }

    if (user.role === ROLES.STUDENT) {
        if (!user.manager) return { ...EMPTY }

        const instructor = await userModel.findById(user.manager).select('role')

        if (!instructor || instructor.role !== ROLES.INSTRUCTOR) return { ...EMPTY }

        return getInstructorEntitlement(instructor._id, now)
    }

    return { ...EMPTY }
}

// True once the instructor has ever completed a payment (renewal vs. first activation).
export const hasPaidBefore = (instructorId) =>
    transactionModel.exists({ user: instructorId, status: 'success' }).then(Boolean)
