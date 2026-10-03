import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getAiConfig, getConfig } from '../src/config/env.js'
import { createAiLimiter } from '../src/services/ai/aiLimiter.js'
import { AI_ERROR_CODES, aiError } from '../src/services/ai/errors.js'
import { createGeminiProvider } from '../src/services/ai/providers/geminiProvider.js'
import { knownProviders, registerProvider, resolveProvider, unregisterProvider } from '../src/services/ai/providers/index.js'
import { createOpenrouterProvider, OPENROUTER_URL } from '../src/services/ai/providers/openrouterProvider.js'

// No test here (or anywhere in the suite) calls a real provider: OpenRouter is exercised through a mocked fetch.
const SECRET = 'sk-or-v1-THIS-IS-A-FAKE-TEST-KEY'
const CONFIG = { openrouterApiKey: SECRET, model: 'openrouter/free', timeoutMs: 1000 }
const REQUEST = { systemPrompt: 'SYSTEM RULES', userPrompt: 'USER DATA', responseFormat: 'json', temperature: 0.2, maxTokens: 500 }

const answer = (status, body) => async () => ({ status, json: async () => body })
const ok = (content = '{"a":1}', extra = {}) => answer(200, { model: 'google/some-free-model', choices: [{ message: { content } }], usage: { total_tokens: 12 }, ...extra })

const codeOf = async (promise) => {
    try {
        await promise

        return null
    } catch (error) {
        return error.extra?.code ?? `NOT_AI:${error.message}`
    }
}

describe('OpenRouter provider: request mapping (mocked fetch)', () => {
    it('posts the documented chat-completions request', async () => {
        const seen = []
        const provider = createOpenrouterProvider(CONFIG, { fetchImpl: async (url, init) => { seen.push({ url, init }); return ok()() }, referer: 'https://app.example' })

        await provider.generate(REQUEST)

        const { url, init } = seen[0]
        const body = JSON.parse(init.body)

        assert.equal(url, OPENROUTER_URL)
        assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
        assert.equal(init.method, 'POST')
        assert.equal(init.headers.Authorization, `Bearer ${SECRET}`)
        assert.equal(init.headers['Content-Type'], 'application/json')
        assert.equal(init.headers['X-Title'], 'Cohortly')
        assert.equal(init.headers['HTTP-Referer'], 'https://app.example')
        assert.equal(body.model, 'openrouter/free')
        assert.deepEqual(body.messages, [{ role: 'system', content: 'SYSTEM RULES' }, { role: 'user', content: 'USER DATA' }])
        assert.equal(body.temperature, 0.2)
        assert.equal(body.max_tokens, 500)
        assert.deepEqual(body.response_format, { type: 'json_object' })
        assert.ok(init.signal)
    })

    it('asks for JSON only when the caller wants JSON', async () => {
        const bodies = []
        const provider = createOpenrouterProvider(CONFIG, { fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return ok('plain text here')() } })

        await provider.generate({ ...REQUEST, responseFormat: 'text' })

        assert.equal('response_format' in bodies[0], false)
    })

    it('returns the text, the model that answered and the usage', async () => {
        const provider = createOpenrouterProvider(CONFIG, { fetchImpl: ok('hello') })
        const result = await provider.generate(REQUEST)

        assert.deepEqual(result, { text: 'hello', model: 'google/some-free-model', usage: { total_tokens: 12 } })
    })

    it('is configured only with a key and a model', () => {
        assert.equal(createOpenrouterProvider(CONFIG).isConfigured(), true)
        assert.equal(createOpenrouterProvider({ ...CONFIG, openrouterApiKey: '' }).isConfigured(), false)
        assert.equal(createOpenrouterProvider({ ...CONFIG, model: '' }).isConfigured(), false)
    })

    it('retries ONCE without response_format when the free model refuses it, and only for JSON requests', async () => {
        let calls = 0
        const bodies = []
        const fetchImpl = async (url, init) => {
            calls += 1
            bodies.push(JSON.parse(init.body))

            return calls === 1 ? answer(400, { error: { code: 400, message: 'response_format is not supported by this model' } })() : ok('{"a":1}')()
        }
        const result = await createOpenrouterProvider(CONFIG, { fetchImpl }).generate(REQUEST)

        assert.equal(result.text, '{"a":1}')
        assert.equal(calls, 2)
        assert.ok(bodies[0].response_format)
        assert.equal('response_format' in bodies[1], false)

        let textCalls = 0
        const text = createOpenrouterProvider(CONFIG, { fetchImpl: async () => { textCalls += 1; return answer(400, {})() } })

        assert.equal(await codeOf(text.generate({ ...REQUEST, responseFormat: 'text' })), 'AI_RESPONSE_INVALID')
        assert.equal(textCalls, 1)

        let stillBad = 0
        const refused = createOpenrouterProvider(CONFIG, { fetchImpl: async () => { stillBad += 1; return answer(404, {})() } })

        assert.equal(await codeOf(refused.generate(REQUEST)), 'AI_RESPONSE_INVALID')
        assert.equal(stillBad, 2)
    })
})

describe('OpenRouter provider: errors become Cohortly errors', () => {
    const generate = (fetchImpl) => createOpenrouterProvider(CONFIG, { fetchImpl }).generate(REQUEST)

    it('maps HTTP statuses', async () => {
        const cases = [[401, 'AI_NOT_CONFIGURED'], [403, 'AI_NOT_CONFIGURED'], [402, 'AI_RATE_LIMITED'], [429, 'AI_RATE_LIMITED'], [408, 'AI_PROVIDER_UNAVAILABLE'], [500, 'AI_PROVIDER_UNAVAILABLE'], [502, 'AI_PROVIDER_UNAVAILABLE'], [503, 'AI_PROVIDER_UNAVAILABLE'], [524, 'AI_PROVIDER_UNAVAILABLE'], [529, 'AI_PROVIDER_UNAVAILABLE'], [422, 'AI_RESPONSE_INVALID']]

        for (const [status, code] of cases) assert.equal(await codeOf(generate(answer(status, { error: { code: status, message: 'provider text' } }))), code, String(status))
    })

    it('maps an error object inside a 200 response', async () => {
        assert.equal(await codeOf(generate(answer(200, { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } }))), 'AI_RATE_LIMITED')
        assert.equal(await codeOf(generate(answer(200, { error: { code: 502, message: 'Provider returned error' } }))), 'AI_PROVIDER_UNAVAILABLE')
    })

    it('network failures and timeouts are "unavailable"', async () => {
        assert.equal(await codeOf(generate(async () => { throw new TypeError('fetch failed') })), 'AI_PROVIDER_UNAVAILABLE')

        const hangs = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
        const started = Date.now()

        assert.equal(await codeOf(createOpenrouterProvider({ ...CONFIG, timeoutMs: 40 }, { fetchImpl: hangs }).generate(REQUEST)), 'AI_PROVIDER_UNAVAILABLE')
        assert.ok(Date.now() - started < 1000)
    })

    it('a malformed success body is AI_RESPONSE_INVALID', async () => {
        for (const body of [{}, { choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: '   ' } }] }, { choices: [{ message: { content: ['parts'] } }] }, null]) {
            assert.equal(await codeOf(generate(answer(200, body))), 'AI_RESPONSE_INVALID', JSON.stringify(body))
        }

        assert.equal(await codeOf(generate(async () => ({ status: 200, json: async () => { throw new Error('not json') } }))), 'AI_RESPONSE_INVALID')
    })

    it('never leaks the key, the raw provider message or its body in an error', async () => {
        for (const status of [401, 429, 500, 422]) {
            try {
                await generate(answer(status, { error: { code: status, message: `provider says ${SECRET} and internal detail` } }))
                assert.fail('should throw')
            } catch (error) {
                const text = JSON.stringify({ message: error.message, extra: error.extra, status: error.status })

                assert.equal(text.includes(SECRET), false)
                assert.equal(text.includes('internal detail'), false)
                assert.equal(text.includes('provider says'), false)
            }
        }
    })
})

describe('provider registry and the Gemini extension point', () => {
    afterEach(() => unregisterProvider('custom'))

    it('knows openrouter and gemini; an unknown provider is a controlled configuration error', () => {
        assert.ok(knownProviders().includes('openrouter'))
        assert.ok(knownProviders().includes('gemini'))
        assert.throws(() => resolveProvider({ provider: 'nope' }), (error) => error.extra.code === 'AI_NOT_CONFIGURED' && error.status === 503)
    })

    it('resolves the configured provider by name', () => {
        assert.equal(resolveProvider({ ...CONFIG, provider: 'openrouter' }).name, 'openrouter')
    })

    it('gemini is recognised but intentionally not implemented: not configured, every call a controlled AI_NOT_CONFIGURED', async () => {
        const provider = resolveProvider({ provider: 'gemini' })

        assert.equal(provider.name, 'gemini')
        assert.equal(provider.isConfigured(), false)
        assert.equal(await codeOf(provider.generate(REQUEST)), 'AI_NOT_CONFIGURED')
        assert.equal(createGeminiProvider().isConfigured(), false)
    })

    it('another provider can be registered without touching any feature code', async () => {
        registerProvider('custom', () => ({ name: 'custom', isConfigured: () => true, generate: async () => ({ text: 'x', model: 'm', usage: null }) }))

        assert.equal((await resolveProvider({ provider: 'custom' }).generate(REQUEST)).text, 'x')
    })
})

describe('AI configuration', () => {
    const env = (values) => {
        const saved = {}

        for (const key of Object.keys(values)) saved[key] = process.env[key]

        Object.assign(process.env, values)

        return () => {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key]
                else process.env[key] = value
            }
        }
    }

    it('has safe defaults: AI is OFF and nothing is required', () => {
        const restore = env({})
        const keys = ['AI_ENABLED', 'AI_PROVIDER', 'AI_MODEL', 'OPENROUTER_API_KEY', 'AI_TIMEOUT_MS', 'AI_MAX_OUTPUT_TOKENS']
        const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

        for (const key of keys) delete process.env[key]

        const config = getConfig().ai

        for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value

        assert.equal(config.enabled, false)
        assert.equal(config.provider, 'openrouter')
        assert.equal(config.model, 'openrouter/free')
        assert.equal(config.openrouterApiKey, '')
        assert.equal(config.timeoutMs, 20000)
        assert.equal(config.maxOutputTokens, 1200)
        restore()
    })

    it('reads the variables, and falls back to defaults for invalid numbers instead of failing startup', () => {
        const restore = env({ AI_ENABLED: 'TRUE', AI_PROVIDER: ' Gemini ', AI_MODEL: 'some/model', AI_TIMEOUT_MS: '5000', AI_MAX_OUTPUT_TOKENS: '800' })
        const good = getAiConfig()

        assert.equal(good.enabled, true)
        assert.equal(good.provider, 'gemini')
        assert.equal(good.model, 'some/model')
        assert.equal(good.timeoutMs, 5000)
        assert.equal(good.maxOutputTokens, 800)

        for (const bad of ['abc', '5.5', '-1', '999999999', '0']) {
            process.env.AI_TIMEOUT_MS = bad
            process.env.AI_MAX_OUTPUT_TOKENS = bad
            assert.equal(getAiConfig().timeoutMs, 20000, bad)
            assert.equal(getAiConfig().maxOutputTokens, 1200, bad)
        }

        restore()
    })
})

describe('usage limiter', () => {
    const config = { cooldownMs: 1000, maxPerUserPerHour: 3, maxPerMinuteGlobal: 5 }
    const blocked = (fn) => assert.throws(fn, (error) => error.extra.code === 'AI_RATE_LIMITED' && error.status === 429)

    it('allows one request at a time per user, and frees the slot on release', () => {
        const limiter = createAiLimiter()
        const release = limiter.acquire('u1', { ...config, cooldownMs: 0 }, 0)

        blocked(() => limiter.acquire('u1', { ...config, cooldownMs: 0 }, 1))
        limiter.acquire('u2', { ...config, cooldownMs: 0 }, 1)() // another user is independent
        release()
        limiter.acquire('u1', { ...config, cooldownMs: 0 }, 2)
    })

    it('enforces the cooldown between one user requests', () => {
        const limiter = createAiLimiter()

        limiter.acquire('u1', config, 0)()
        blocked(() => limiter.acquire('u1', config, 500))
        limiter.acquire('u1', config, 1500)()
    })

    it('caps requests per user per hour and forgets older ones', () => {
        const limiter = createAiLimiter()
        const open = { ...config, cooldownMs: 0 }

        for (let i = 0; i < 3; i += 1) limiter.acquire('u1', open, i * 1000)()

        blocked(() => limiter.acquire('u1', open, 10_000))
        limiter.acquire('u1', open, 3_700_000)() // more than an hour later
    })

    it('caps all users together per minute (protecting the provider quota)', () => {
        const limiter = createAiLimiter()
        const open = { ...config, cooldownMs: 0, maxPerUserPerHour: 100 }

        for (let i = 0; i < 5; i += 1) limiter.acquire(`user-${i}`, open, i)()

        blocked(() => limiter.acquire('user-9', open, 1000))
        limiter.acquire('user-9', open, 61_000)()
    })
})

describe('AI error contract', () => {
    it('has the documented codes, each with a status and a safe message', () => {
        assert.deepEqual([...AI_ERROR_CODES].sort(), ['AI_CONTEXT_TOO_LARGE', 'AI_DISABLED', 'AI_NOT_CONFIGURED', 'AI_NO_TEXT_CONTEXT', 'AI_PROVIDER_UNAVAILABLE', 'AI_RATE_LIMITED', 'AI_RESPONSE_INVALID'])

        const statuses = Object.fromEntries(AI_ERROR_CODES.map((code) => [code, aiError(code).status]))

        assert.deepEqual(statuses, { AI_DISABLED: 503, AI_NOT_CONFIGURED: 503, AI_PROVIDER_UNAVAILABLE: 503, AI_RATE_LIMITED: 429, AI_RESPONSE_INVALID: 502, AI_CONTEXT_TOO_LARGE: 413, AI_NO_TEXT_CONTEXT: 422 })

        for (const code of AI_ERROR_CODES) assert.ok(aiError(code).message.length > 10 && !/openrouter|gemini|key|token/i.test(aiError(code).message), code)
    })
})
