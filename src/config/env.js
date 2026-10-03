const REQUIRED = ['DATABASE_URL', 'SECRET_KEY_JWT', 'APP_URL', 'FRONTEND_URL']

const trimSlash = (value) => (value ?? '').replace(/\/+$/, '')

// Optional AI assistance (M9). NOTHING here is required: with AI_ENABLED unset or false, or no key,
// the backend boots and every AI endpoint answers with a controlled "unavailable" state.
// Invalid numbers fall back to safe defaults instead of failing startup.
const boundedInt = (value, fallback, min, max) => {
    const number = Number(value)

    return Number.isInteger(number) && number >= min && number <= max ? number : fallback
}

export const getAiConfig = () => ({
    enabled: String(process.env.AI_ENABLED ?? 'false').toLowerCase() === 'true',
    provider: String(process.env.AI_PROVIDER ?? 'openrouter').trim().toLowerCase(),
    model: String(process.env.AI_MODEL ?? 'openrouter/free').trim(),
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    timeoutMs: boundedInt(process.env.AI_TIMEOUT_MS, 20000, 1000, 120000),
    maxOutputTokens: boundedInt(process.env.AI_MAX_OUTPUT_TOKENS, 1200, 100, 4000),
    // usage protection (see services/ai/aiLimiter.js)
    cooldownMs: boundedInt(process.env.AI_USER_COOLDOWN_MS, 3000, 0, 600000),
    maxPerUserPerHour: boundedInt(process.env.AI_USER_MAX_PER_HOUR, 30, 1, 10000),
    maxPerMinuteGlobal: boundedInt(process.env.AI_GLOBAL_MAX_PER_MINUTE, 15, 1, 10000),
})

export const getConfig = () => ({
    port: Number(process.env.PORT) || 3000,
    databaseUrl: process.env.DATABASE_URL ?? '',
    jwtSecret: process.env.SECRET_KEY_JWT ?? '',
    // public base URL of this backend, used to build image URLs
    appUrl: trimSlash(process.env.APP_URL),
    // public base URL of the frontend, used for payment redirects and CORS
    frontendUrl: trimSlash(process.env.FRONTEND_URL),
    corsOrigins: (process.env.CORS_ORIGIN ?? process.env.FRONTEND_URL ?? '')
        .split(',')
        .map((origin) => trimSlash(origin.trim()))
        .filter(Boolean),
    midtransUrl: process.env.MIDTRANS_URL ?? '',
    midtransAuthString: process.env.MIDTRANS_AUTH_STRING ?? '',
    // optional explicit server key; otherwise derived from MIDTRANS_AUTH_STRING
    midtransServerKey: process.env.MIDTRANS_SERVER_KEY ?? '',
    subscriptionPrice: Number(process.env.SUBSCRIPTION_PRICE) || 280000,
    // calendar months of access bought by one successful payment
    subscriptionPeriodMonths: Number(process.env.SUBSCRIPTION_PERIOD_MONTHS) || 1,
    ai: getAiConfig(),
})

// Throws a readable error listing every problem. Never prints secret values.
export const validateConfig = () => {
    const problems = REQUIRED.filter((key) => !process.env[key]).map(
        (key) => `${key} is required`
    )

    if (process.env.SECRET_KEY_JWT && process.env.SECRET_KEY_JWT.length < 16) {
        problems.push('SECRET_KEY_JWT must be at least 16 characters')
    }

    if (process.env.PORT && !Number.isInteger(Number(process.env.PORT))) {
        problems.push('PORT must be an integer')
    }

    if (process.env.SUBSCRIPTION_PERIOD_MONTHS) {
        const months = Number(process.env.SUBSCRIPTION_PERIOD_MONTHS)

        if (!Number.isInteger(months) || months < 1 || months > 24) {
            problems.push('SUBSCRIPTION_PERIOD_MONTHS must be an integer between 1 and 24')
        }
    }

    if (problems.length > 0) {
        throw new Error(`Invalid environment configuration:\n - ${problems.join('\n - ')}`)
    }

    const cfg = getConfig()

    if (!cfg.midtransUrl || !cfg.midtransAuthString) {
        console.warn(
            'MIDTRANS_URL / MIDTRANS_AUTH_STRING not set: sign-up payments and the payment webhook will fail closed.'
        )
    }

    return cfg
}

// Midtrans signs notifications with the SERVER KEY. MIDTRANS_AUTH_STRING is
// base64("<server key>:") so the key can be derived without new credentials.
export const getMidtransServerKey = () => {
    const { midtransServerKey, midtransAuthString } = getConfig()

    if (midtransServerKey) return midtransServerKey
    if (!midtransAuthString) return ''

    const decoded = Buffer.from(midtransAuthString, 'base64').toString('utf8')

    return decoded.endsWith(':') ? decoded.slice(0, -1) : decoded
}
