import { forbidden } from '../utils/httpError.js'

// Must run after verifyToken. Usage: requireRole(ROLES.INSTRUCTOR)
export const requireRole =
    (...roles) =>
    (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return next(forbidden('You are not allowed to perform this action'))
        }

        next()
    }
