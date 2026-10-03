import { asyncHandler } from '../utils/asyncHandler.js'
import { forbidden } from '../utils/httpError.js'
import { ACCESS } from '../utils/accessStatus.js'
import { ROLES } from '../utils/roles.js'
import { getEntitlementForUser } from '../services/entitlement.js'

// Hard entitlement gate. Runs after verifyToken and a role check.
// This is NOT an authentication failure: the caller is a known user whose
// workspace subscription is not ACTIVE (never paid, pending, failed or expired).
//  - instructor: 403 ACCESS_NOT_ACTIVE
//  - student:    403 WORKSPACE_ACCESS_INACTIVE (the instructor's workspace decides)
export const requireActiveAccess = asyncHandler(async (req, res, next) => {
    const entitlement = await getEntitlementForUser(req.user)

    req.entitlement = entitlement

    if (entitlement.accessStatus !== ACCESS.ACTIVE) {
        const isStudent = req.user.role === ROLES.STUDENT

        throw forbidden(
            isStudent
                ? 'Your organization does not currently have access. Please contact your instructor.'
                : 'Your workspace is not active. Complete the payment to continue.',
            {
                code: isStudent ? 'WORKSPACE_ACCESS_INACTIVE' : 'ACCESS_NOT_ACTIVE',
                accessStatus: entitlement.accessStatus,
                accessExpiresAt: entitlement.accessExpiresAt,
            }
        )
    }

    next()
})
