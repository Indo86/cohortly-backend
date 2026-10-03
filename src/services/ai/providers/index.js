import { getConfig } from '../../../config/env.js'
import { aiError } from '../errors.js'
import { createGeminiProvider } from './geminiProvider.js'
import { createOpenrouterProvider } from './openrouterProvider.js'

// The provider registry. A provider is a factory: (aiConfig) -> { name, isConfigured(), generate(request) }.
// The rest of Cohortly asks for "the configured provider" and never imports a provider module, so
// adding or replacing one is a registration, not a rewrite. Tests register a fake provider here, so
// no automated test ever calls an external service.
const factories = new Map([
    ['openrouter', (config) => createOpenrouterProvider(config, { referer: getConfig().frontendUrl })],
    ['gemini', createGeminiProvider],
])

export const registerProvider = (name, factory) => factories.set(name, factory)
export const unregisterProvider = (name) => factories.delete(name)
export const knownProviders = () => [...factories.keys()]

// An unknown AI_PROVIDER is a configuration problem: a controlled error, never a crash.
export const resolveProvider = (aiConfig) => {
    const factory = factories.get(aiConfig.provider)

    if (!factory) throw aiError('AI_NOT_CONFIGURED')

    return factory(aiConfig)
}
