import { getConfig } from '../../config/env.js'
import { aiLimiter } from './aiLimiter.js'
import { aiError } from './errors.js'
import { lessonQuestionPrompt } from './prompts/lessonQuestion.js'
import { lessonSummaryPrompt } from './prompts/lessonSummary.js'
import { practiceQuestionsPrompt, PRACTICE_COUNT } from './prompts/practiceQuestions.js'
import { quizDraftPrompt } from './prompts/quizDraft.js'
import { knownProviders, resolveProvider } from './providers/index.js'
import {
    askOutputSchema, extractJson, parsePracticeQuestion, practiceOutputSchema, quizDraftOutputSchema, summaryOutputSchema, toQuizQuestion,
} from './schemas/outputs.js'

// The application-level AI operations. Controllers call ONLY these four functions (plus the
// status/availability helpers): they never import a provider. Each operation
//   1. checks that AI is enabled and the configured provider is usable (controlled errors otherwise),
//   2. takes the per-user / global usage slot (aiLimiter),
//   3. asks the provider with a prompt built by the BACKEND from backend-built context,
//   4. validates the provider output and returns a normalized result (or AI_RESPONSE_INVALID).
// AI output is generated text that may be wrong: nothing in here writes to the database, scores,
// decides progress or completion, or issues certificates.

export const getAiStatus = () => {
    const config = getConfig().ai
    let available = false

    if (config.enabled && knownProviders().includes(config.provider)) {
        try {
            available = Boolean(resolveProvider(config).isConfigured())
        } catch {
            available = false
        }
    }

    // never calls the provider, never exposes the key, the model or any provider detail
    return { enabled: config.enabled, available, provider: config.enabled ? config.provider : null }
}

// Throws the controlled error when the AI tools cannot be used. Cheap: used before any cache read.
export const assertAiAvailable = () => {
    const config = getConfig().ai

    if (!config.enabled) throw aiError('AI_DISABLED')

    const provider = resolveProvider(config)

    if (!provider.isConfigured()) throw aiError('AI_NOT_CONFIGURED')

    return { config, provider }
}

// Operational logging only: feature, provider, outcome, latency. Never prompts, content or keys.
const log = (entry) => {
    if (process.env.NODE_ENV !== 'test') console.info(JSON.stringify({ event: 'ai', ...entry }))
}

const run = async ({ feature, userId, work }) => {
    const { config, provider } = assertAiAvailable()
    const release = aiLimiter.acquire(userId, config)
    const started = Date.now()

    try {
        const result = await work({ config, provider })

        log({ feature, provider: provider.name, ok: true, latencyMs: Date.now() - started })

        return result
    } catch (error) {
        log({ feature, provider: provider.name, ok: false, code: error.extra?.code ?? 'AI_ERROR', latencyMs: Date.now() - started })

        throw error
    } finally {
        release()
    }
}

const ask = (provider, config, prompt) =>
    provider.generate({
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        responseFormat: prompt.responseFormat,
        temperature: prompt.temperature,
        maxTokens: config.maxOutputTokens,
    })

// Model output is untrusted. `read` turns the reply text into a validated value or returns
// undefined. One malformed reply is retried once (the model is not deterministic); after that the
// request fails with AI_RESPONSE_INVALID and nothing is kept.
const generateValidated = async ({ provider, config, prompt, read }) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const reply = await ask(provider, config, prompt)
        const value = read(reply.text)

        if (value !== undefined) return { value, model: reply.model }
    }

    throw aiError('AI_RESPONSE_INVALID')
}

const now = () => new Date().toISOString()

export const askAboutLesson = ({ userId, context, question }) =>
    run({
        feature: 'lesson-question',
        userId,
        work: async ({ provider, config }) => {
            const { value } = await generateValidated({
                provider,
                config,
                prompt: lessonQuestionPrompt({ context, question }),
                read: (text) => {
                    const parsed = askOutputSchema.safeParse(extractJson(text))

                    return parsed.success ? parsed.data : undefined
                },
            })

            return { answer: value.answer, groundedInLesson: value.groundedInLesson, generatedAt: now() }
        },
    })

export const summarizeLesson = ({ userId, context }) =>
    run({
        feature: 'lesson-summary',
        userId,
        work: async ({ provider, config }) => {
            const { value, model } = await generateValidated({
                provider,
                config,
                prompt: lessonSummaryPrompt({ context }),
                read: (text) => {
                    const parsed = summaryOutputSchema.safeParse(text)

                    return parsed.success ? parsed.data : undefined
                },
            })

            return { summary: value, generatedAt: now(), provider: provider.name, model }
        },
    })

export const generatePracticeQuestions = ({ userId, context, count = PRACTICE_COUNT }) =>
    run({
        feature: 'practice-questions',
        userId,
        work: async ({ provider, config }) => {
            const { value } = await generateValidated({
                provider,
                config,
                prompt: practiceQuestionsPrompt({ context, count }),
                read: (text) => {
                    const envelope = practiceOutputSchema.safeParse(extractJson(text))

                    if (!envelope.success) return undefined

                    // keep every question that is valid; a reply with none is invalid
                    const questions = envelope.data.questions
                        .map((item) => parsePracticeQuestion(item))
                        .filter((result) => result.success)
                        .map(({ data }) => ({ question: data.question, options: data.options, answer: data.correctIndex, explanation: data.explanation }))
                        .slice(0, count)

                    return questions.length > 0 ? questions : undefined
                },
            })

            return { questions: value, generatedAt: now() }
        },
    })

// A DRAFT only. The result has exactly the shape of the M8 quiz API, but nothing is created or saved:
// the instructor reviews it and applies it through the normal quiz endpoints.
export const generateQuizDraft = ({ userId, context, count, focus }) =>
    run({
        feature: 'quiz-draft',
        userId,
        work: async ({ provider, config }) => {
            let dropped = 0
            const { value } = await generateValidated({
                provider,
                config,
                prompt: quizDraftPrompt({ context, count, focus }),
                read: (text) => {
                    const envelope = quizDraftOutputSchema.safeParse(extractJson(text))

                    if (!envelope.success) return undefined

                    dropped = 0

                    const seen = new Set()
                    const questions = []

                    for (const item of envelope.data.questions) {
                        const question = toQuizQuestion(item)
                        const key = question?.prompt.toLowerCase()

                        if (!question || seen.has(key)) {
                            dropped += 1

                            continue
                        }

                        seen.add(key)
                        questions.push(question)
                    }

                    return questions.length > 0 ? questions.slice(0, count) : undefined
                },
            })

            return { questions: value, dropped, generatedAt: now() }
        },
    })
