import { aiError } from '../errors.js'

// EXTENSION POINT, not an integration.
//
// AI_PROVIDER=gemini is understood by the provider registry, so the choice is recognised and the
// application starts normally. It is intentionally NOT implemented in M9: this provider reports
// itself as not configured and every request answers AI_NOT_CONFIGURED (a controlled 503), so
// nothing can half-work or leak. It was left out because the Gemini REST contract was not verified
// against its current documentation in this milestone, and guessing an API is worse than a clear gap.
//
// To add Gemini, implement the provider contract below and nothing else changes (the four
// application operations in aiService.js, the prompts, the limits and the controllers do not know
// which provider answers):
//
//   generate({ systemPrompt, userPrompt, responseFormat: 'text' | 'json', temperature, maxTokens })
//     -> Promise<{ text: string, model: string, usage: object | null }>
//   failures must be thrown as aiError(...) (see ../errors.js): AI_PROVIDER_UNAVAILABLE,
//   AI_RATE_LIMITED, AI_NOT_CONFIGURED or AI_RESPONSE_INVALID, never a raw provider error.
export const createGeminiProvider = () => ({
    name: 'gemini',
    isConfigured: () => false,
    generate: async () => {
        throw aiError('AI_NOT_CONFIGURED')
    },
})
