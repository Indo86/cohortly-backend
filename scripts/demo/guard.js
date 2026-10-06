// Where the demo seed may run. It deletes and recreates the demo workspace, so it must never touch a
// production database by accident:
//   - NODE_ENV=production                    -> refused
//   - a database name that contains "prod"   -> refused
//   - a non-local host (Atlas, a server...)  -> refused unless DEMO_SEED_ALLOW_REMOTE=true
//     (for a dedicated demo database, e.g. the one behind a deployed demo)
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

const parse = (databaseUrl) => {
    const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)(?:\/([^?]*))?/i.exec(String(databaseUrl ?? ''))

    if (!match) return null

    const hosts = match[1].split(',').map((host) => host.replace(/:\d+$/, '').toLowerCase())

    return { hosts, database: decodeURIComponent(match[2] ?? '') }
}

// Returns null when the target is acceptable, otherwise the reason it is refused.
export const demoTargetProblem = (databaseUrl, env = process.env) => {
    if (env.NODE_ENV === 'production') return 'NODE_ENV is production'

    const target = parse(databaseUrl)

    if (!target) return 'DATABASE_URL is missing or not a MongoDB connection string'
    if (/prod/i.test(target.database)) return `the database name "${target.database}" looks like production`

    const local = target.hosts.every((host) => LOCAL_HOSTS.has(host))

    if (!local && env.DEMO_SEED_ALLOW_REMOTE !== 'true') {
        return 'the database is not local; set DEMO_SEED_ALLOW_REMOTE=true only for a dedicated demo database'
    }

    return null
}
