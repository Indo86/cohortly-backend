import { aiError } from '../errors.js'

// OpenRouter, the primary development/demo provider.
// Verified against the current OpenRouter documentation (Chat Completions):
//   POST https://openrouter.ai/api/v1/chat/completions
//   Authorization: Bearer <key>;   optional attribution headers HTTP-Referer and X-Title
//   body: { model, messages: [{ role, content }], temperature, max_tokens, response_format }
//   200: { choices: [{ message: { content } }], usage }
//   errors: { error: { code, message } } with HTTP 402 (credits), 429 (rate limit), 5xx
// `openrouter/free` is OpenRouter's free-models router: it picks a free model that supports the
// features of the request. Not every free model supports `response_format`, so a JSON request that
// is refused (400/404) is retried ONCE without it: the prompts already demand JSON and the caller
// validates the result anyway.
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// Everything the application layer sees from a provider failure. The raw body is never kept.
const classify = (status, bodyCode) => {
    const code = Number(bodyCode) || status

    if (code === 401 || code === 403) return 'AI_NOT_CONFIGURED' // the key is wrong or revoked: not the user's problem
    if (code === 402 || code === 429) return 'AI_RATE_LIMITED' // free quota or credits exhausted
    if (code === 408 || code >= 500) return 'AI_PROVIDER_UNAVAILABLE'

    return 'AI_RESPONSE_INVALID'
}

export const createOpenrouterProvider = (config, { fetchImpl = (...args) => fetch(...args), referer = '' } = {}) => {
    const send = async ({ systemPrompt, userPrompt, responseFormat, temperature, maxTokens }, withFormat) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), config.timeoutMs)

        let response

        try {
            response = await fetchImpl(OPENROUTER_URL, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    Authorization: `Bearer ${config.openrouterApiKey}`,
                    'Content-Type': 'application/json',
                    'X-Title': 'Cohortly',
                    ...(referer ? { 'HTTP-Referer': referer } : {}),
                },
                body: JSON.stringify({
                    model: config.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    temperature,
                    max_tokens: maxTokens,
                    ...(withFormat && responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
                }),
            })
        } catch {
            // network failure, DNS, abort (timeout): all the same "unavailable" to the application
            throw aiError('AI_PROVIDER_UNAVAILABLE')
        } finally {
            clearTimeout(timer)
        }

        const body = await response.json().catch(() => null)

        return { status: response.status, body }
    }

    const generate = async (request) => {
        let { status, body } = await send(request, true)

        // some free models do not support response_format: try once more without it
        if (request.responseFormat === 'json' && (status === 400 || status === 404)) {
            ;({ status, body } = await send(request, false))
        }

        // OpenRouter can answer 200 with an error object inside
        if (status >= 400 || body?.error) throw aiError(classify(status, body?.error?.code))

        const content = body?.choices?.[0]?.message?.content

        if (typeof content !== 'string' || content.trim() === '') throw aiError('AI_RESPONSE_INVALID')

        return { text: content, model: body.model ?? config.model, usage: body.usage ?? null }
    }

    return {
        name: 'openrouter',
        isConfigured: () => Boolean(config.openrouterApiKey && config.model),
        generate,
    }
}
