import { aiLimiter } from '../src/services/ai/aiLimiter.js'
import { aiError } from '../src/services/ai/errors.js'
import { registerProvider, unregisterProvider } from '../src/services/ai/providers/index.js'

// Test harness for the AI layer. NO automated test talks to a real provider: AI_PROVIDER points at a
// fake registered here, and the OpenRouter HTTP mapping is tested separately with a mocked fetch.
// So the suite consumes zero free-tier quota and needs no API key.

export const AI_ENV = {
    AI_ENABLED: 'true',
    AI_PROVIDER: 'fake',
    AI_MODEL: 'fake-model',
    AI_USER_COOLDOWN_MS: '0',
    AI_USER_MAX_PER_HOUR: '1000',
    AI_GLOBAL_MAX_PER_MINUTE: '1000',
}

const KEYS = [...Object.keys(AI_ENV), 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'AI_TIMEOUT_MS', 'AI_MAX_OUTPUT_TOKENS']

// Installs the fake provider and the env; returns a controller. `behaviour(request)` decides the reply.
export const useFakeProvider = () => {
    const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
    const harness = {
        calls: [],
        configured: true,
        behaviour: async () => ({ text: '{}', model: 'fake-model-1', usage: null }),
        // convenience: always answer with this text
        replyWith(text) {
            harness.behaviour = async () => ({ text, model: 'fake-model-1', usage: null })
        },
        // answer with a sequence of texts, one per call (the last repeats)
        replySequence(...texts) {
            let index = 0

            harness.behaviour = async () => ({ text: texts[Math.min(index++, texts.length - 1)], model: 'fake-model-1', usage: null })
        },
        failWith(code) {
            harness.behaviour = async () => {
                throw aiError(code)
            }
        },
        enable(overrides = {}) {
            Object.assign(process.env, AI_ENV, overrides)
            aiLimiter.reset()
        },
        disable() {
            process.env.AI_ENABLED = 'false'
        },
        restore() {
            for (const key of KEYS) {
                if (saved[key] === undefined) delete process.env[key]
                else process.env[key] = saved[key]
            }

            unregisterProvider('fake')
            aiLimiter.reset()
        },
        // everything that would have been sent to a provider
        sent: () => JSON.stringify(harness.calls),
    }

    registerProvider('fake', () => ({
        name: 'fake',
        isConfigured: () => harness.configured,
        generate: async (request) => {
            harness.calls.push(request)

            return harness.behaviour(request)
        },
    }))
    harness.enable()

    return harness
}

export const askReply = (answer = 'A closure keeps access to variables from where it was created.', grounded = true) =>
    JSON.stringify({ answer, groundedInLesson: grounded })

export const practiceReply = (questions) =>
    JSON.stringify({
        questions: questions ?? [
            { question: 'What does a closure keep?', options: ['Access to outer variables', 'A copy of the DOM', 'Nothing'], correctIndex: 0, explanation: 'It keeps access to the scope where it was created.' },
            { question: 'Where is a closure created?', options: ['Inside a function', 'Only in classes', 'Only globally', 'Never'], correctIndex: 0, explanation: 'Functions create closures.' },
            { question: 'Is a closure a variable?', options: ['No, it is a function with scope', 'Yes'], correctIndex: 0, explanation: 'It is a function plus its scope.' },
        ],
    })

export const draftReply = (questions) =>
    JSON.stringify({
        questions: questions ?? [
            { prompt: 'What does a closure keep?', options: ['Access to outer variables', 'A copy of the DOM', 'Nothing'], correctIndex: 0 },
            { prompt: 'Which statement is true?', options: ['Functions create closures', 'Classes create closures only'], correctIndex: 0 },
        ],
    })

export const SUMMARY_TEXT = 'A closure is a function that remembers its surrounding scope.\n- It keeps access to outer variables.\n- It is created when a function is defined.'
