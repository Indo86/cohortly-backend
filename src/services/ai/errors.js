import { HttpError } from '../../utils/httpError.js'

// The Cohortly AI error contract. Every failure of the AI layer, whatever the provider said, becomes
// one of these: a stable `code` for the client and a SAFE message. Raw provider bodies, status lines,
// headers and credentials never leave the backend.
const DEFINITIONS = {
    AI_DISABLED: [503, 'AI study tools are turned off.'],
    AI_NOT_CONFIGURED: [503, 'AI study tools are not available right now.'],
    AI_PROVIDER_UNAVAILABLE: [503, 'AI study tools are temporarily unavailable.'],
    AI_RATE_LIMITED: [429, 'AI study tools have reached their current usage limit. Try again later.'],
    AI_RESPONSE_INVALID: [502, 'The AI response could not be used. Please try again.'],
    AI_CONTEXT_TOO_LARGE: [413, 'This content is too large for AI study tools.'],
    AI_NO_TEXT_CONTEXT: [422, 'There is not enough text for AI study tools to use.'],
}

export const AI_ERROR_CODES = Object.freeze(Object.keys(DEFINITIONS))

export const aiError = (code, message) => {
    const [status, fallback] = DEFINITIONS[code]

    return new HttpError(status, message ?? fallback, { code })
}
