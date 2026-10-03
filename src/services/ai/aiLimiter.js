import { aiError } from './errors.js'

// A small in-memory usage limiter for the free-tier provider. Portfolio scale: it lives in one
// process (documented limit: with several backend instances each would count separately).
//   - one AI request at a time per user (concurrency),
//   - a short cooldown between requests of one user,
//   - a per-user cap per hour,
//   - a global cap per minute, kept below the provider's own per-minute limit.
// Requests that fail validation never reach it, so they cost nothing.
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

export const createAiLimiter = () => {
    const inFlight = new Set()
    const last = new Map()
    const hourly = new Map()
    let global = []

    // Returns a function that releases the user's concurrency slot; throws AI_RATE_LIMITED otherwise.
    const acquire = (userId, config, now = Date.now()) => {
        const user = String(userId)

        if (inFlight.has(user)) throw aiError('AI_RATE_LIMITED', 'Please wait for your previous AI request to finish.')

        const previous = last.get(user)

        if (config.cooldownMs > 0 && previous !== undefined && now - previous < config.cooldownMs) {
            throw aiError('AI_RATE_LIMITED', 'Please wait a moment before using AI again.')
        }

        const recent = (hourly.get(user) ?? []).filter((time) => now - time < HOUR)

        if (recent.length >= config.maxPerUserPerHour) throw aiError('AI_RATE_LIMITED')

        global = global.filter((time) => now - time < MINUTE)

        if (global.length >= config.maxPerMinuteGlobal) throw aiError('AI_RATE_LIMITED')

        recent.push(now)
        hourly.set(user, recent)
        global.push(now)
        last.set(user, now)
        inFlight.add(user)

        return () => inFlight.delete(user)
    }

    const reset = () => {
        inFlight.clear()
        last.clear()
        hourly.clear()
        global = []
    }

    return { acquire, reset }
}

export const aiLimiter = createAiLimiter()
