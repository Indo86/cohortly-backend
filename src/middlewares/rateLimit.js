import { ipKeyGenerator, rateLimit } from 'express-rate-limit'

// Route-specific rate limits for the endpoints that are abuse-prone (brute force, credential stuffing,
// spam sign-ups, scanning the public verification). There is deliberately NO global limit: normal
// browsing, learning and editing are never throttled.
//
// The limiters are created per app (createApp -> app.locals.rateLimiters), so every app instance, and
// therefore every test file, starts with empty counters. Counters live in memory: with several backend
// instances each counts separately (use a shared store such as Redis before scaling out).
const MINUTE = 60 * 1000

export const RATE_LIMITS = Object.freeze({
    // failed sign-ins for ONE account from one address: stops password guessing on an account
    signInAccount: { windowMs: 15 * MINUTE, limit: 10 },
    // failed sign-ins from one address over all accounts: stops credential stuffing. Successful sign-ins
    // are not counted, so a whole class behind one office/school IP can still sign in.
    signInAddress: { windowMs: 15 * MINUTE, limit: 50 },
    // sign-ups from one address (each one creates an account and a payment order)
    signUp: { windowMs: 60 * MINUTE, limit: 10 },
    // public certificate verification from one address (enumeration / scraping)
    certificateVerify: { windowMs: MINUTE, limit: 30 },
})

const MESSAGES = {
    signInAccount: 'Too many failed sign-in attempts. Please wait a few minutes and try again.',
    signInAddress: 'Too many failed sign-in attempts. Please wait a few minutes and try again.',
    signUp: 'Too many sign-up attempts. Please try again later.',
    certificateVerify: 'Too many verification requests. Please wait a minute and try again.',
}

const addressKey = (req) => ipKeyGenerator(req.ip ?? '')
const accountKey = (req) => `${addressKey(req)}|${String(req.body?.email ?? '').trim().toLowerCase()}`

const limiter = (name, { key = addressKey, failedOnly = false } = {}) =>
    rateLimit({
        ...RATE_LIMITS[name],
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        keyGenerator: key,
        skipSuccessfulRequests: failedOnly,
        // the usual error contract: { message, code }
        handler: (req, res, next, options) =>
            res.status(options.statusCode).json({ message: MESSAGES[name], code: 'RATE_LIMITED' }),
    })

// One set of limiters for one app. Disabled -> no limiters (see config/env.js rateLimitEnabled).
export const createRateLimiters = ({ enabled }) =>
    enabled
        ? {
              signIn: [
                  limiter('signInAddress', { failedOnly: true }),
                  limiter('signInAccount', { key: accountKey, failedOnly: true }),
              ],
              signUp: [limiter('signUp')],
              certificateVerify: [limiter('certificateVerify')],
          }
        : {}

// Route middleware: runs the named limiters of the app that serves the request (none when disabled).
export const rateLimitFor = (name) => (req, res, next) => {
    const chain = req.app.locals.rateLimiters?.[name] ?? []
    let index = 0

    const step = (error) => {
        if (error) return next(error)
        if (index >= chain.length) return next()

        return chain[index++](req, res, step)
    }

    return step()
}
