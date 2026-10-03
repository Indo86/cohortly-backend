export class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message)
        this.status = status
        this.extra = extra
    }
}

export const badRequest = (message, extra) => new HttpError(400, message, extra)
export const unauthorized = (message = 'Unauthorized', extra) => new HttpError(401, message, extra)
export const forbidden = (message = 'Forbidden', extra) => new HttpError(403, message, extra)
export const notFound = (message = 'Not found', extra) => new HttpError(404, message, extra)
export const conflict = (message, extra) => new HttpError(409, message, extra)
