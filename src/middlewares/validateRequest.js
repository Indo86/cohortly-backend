import mongoose from 'mongoose'
import { badRequest } from '../utils/httpError.js'

export const formatZodIssues = (error) =>
    error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
    }))

// Parses req.body with a zod schema and replaces it with the parsed value.
export const validateRequest = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body ?? {})

    if (!result.success) {
        return next(
            badRequest('Validation error', { errors: formatZodIssues(result.error) })
        )
    }

    req.body = result.data
    next()
}

// For handlers that validate multipart bodies themselves (after multer ran).
export const parseOrThrow = (schema, data) => {
    const result = schema.safeParse(data ?? {})

    if (!result.success) {
        throw badRequest('Validation error', { errors: formatZodIssues(result.error) })
    }

    return result.data
}

// Rejects malformed ObjectId route params with 400 before they reach Mongoose.
export const validateObjectId =
    (...names) =>
    (req, res, next) => {
        for (const name of names) {
            if (!mongoose.isValidObjectId(req.params[name])) {
                return next(badRequest(`Invalid ${name}`))
            }
        }

        next()
    }
