import { verifyToken } from './verifyToken.js'
import { requireRole } from './requireRole.js'
import { requireActiveAccess } from './requireActiveAccess.js'
import { ROLES } from '../utils/roles.js'

// Product (LMS) endpoints require the workspace subscription to be ACTIVE for
// BOTH roles: instructors need their own, students inherit their instructor's.
// Identity and payment-recovery endpoints (sign-in, /me, /payment/checkout,
// /health) use verifyToken / requireRole only and stay reachable.

// Instructor endpoints: authenticated + INSTRUCTOR role + ACTIVE workspace.
export const instructorOnly = [
    verifyToken,
    requireRole(ROLES.INSTRUCTOR),
    requireActiveAccess,
]

// Student endpoints: authenticated + STUDENT role + ACTIVE instructor workspace.
export const studentOnly = [
    verifyToken,
    requireRole(ROLES.STUDENT),
    requireActiveAccess,
]

// Authenticated, any role, no entitlement required (identity, categories).
export const authenticated = [verifyToken]

// Endpoints both roles may call, each under its own entitlement rule.
export const instructorOrStudent = [
    verifyToken,
    requireRole(ROLES.INSTRUCTOR, ROLES.STUDENT),
    requireActiveAccess,
]
