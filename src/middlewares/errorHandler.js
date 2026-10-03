import multer from 'multer'
import { ZodError } from 'zod'
import { HttpError } from '../utils/httpError.js'
import { formatZodIssues } from './validateRequest.js'

export const notFoundHandler = (req, res) =>
    res.status(404).json({ message: 'Route not found' })

// Single place that turns errors into the response contract:
// { message, errors? , code? }. Never leaks stacks or internals.
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
    if (err instanceof HttpError) {
        return res.status(err.status).json({ message: err.message, ...err.extra })
    }

    if (err instanceof ZodError) {
        return res
            .status(400)
            .json({ message: 'Validation error', errors: formatZodIssues(err) })
    }

    if (err instanceof multer.MulterError) {
        const tooLarge = err.code === 'LIMIT_FILE_SIZE'

        return res.status(tooLarge ? 413 : 400).json({
            message: tooLarge ? 'File is too large' : 'Invalid file upload',
        })
    }

    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ message: 'Malformed JSON body' })
    }

    if (err?.type === 'entity.too.large') {
        return res.status(413).json({ message: 'Request body is too large' })
    }

    // two instructors (or tabs) edited the same quiz at once: the loser retries on fresh data
    if (err?.name === 'VersionError') {
        return res.status(409).json({ message: 'This was changed elsewhere. Reload and try again.', code: 'CONFLICT' })
    }

    if (err?.code === 11000) {
        return res.status(409).json({ message: 'Resource already exists' })
    }

    if (err?.name === 'ValidationError' || err?.name === 'CastError') {
        return res.status(400).json({ message: 'Validation error' })
    }

    console.error(err)

    return res.status(500).json({ message: 'Internal server error' })
}
