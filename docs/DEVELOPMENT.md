# Development guide

## Requirements

- Node.js 22 or newer
- npm
- MongoDB reachable through a connection string

Node 22 is required by the installed `file-type` dependency. The test suite additionally uses MongoDB Memory Server and does not require a manually started test database.

## Local setup

```bash
git clone https://github.com/Indo86/cohortly-backend.git
cd cohortly-backend
npm ci
cp env.example .env
```

At minimum, configure:

```dotenv
DATABASE_URL=mongodb://127.0.0.1:27017/lms
SECRET_KEY_JWT=replace-with-a-long-random-secret
APP_URL=http://localhost:3000
FRONTEND_URL=http://localhost:5173
```

Then initialize categories and start the API:

```bash
npm run seed
npm run dev
```

`npm run dev` uses Nodemon. `npm start` starts the same entry point without file watching. This JavaScript service has no build step.

## Environment variables

Copy `env.example`; do not commit `.env`.

### Required

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | MongoDB connection string |
| `SECRET_KEY_JWT` | HS256 signing secret; startup requires at least 16 characters |
| `APP_URL` | Public backend base URL used to construct upload URLs |
| `FRONTEND_URL` | Frontend base URL used by CORS and Midtrans return callbacks |

### Server and access

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `CORS_ORIGIN` | `FRONTEND_URL` | Comma-separated browser origin allow-list |
| `SUBSCRIPTION_PRICE` | `280000` | Price of one subscription grant in IDR |
| `SUBSCRIPTION_PERIOD_MONTHS` | `1` | Calendar months per successful payment; integer 1–24 |
| `RATE_LIMIT_ENABLED` | enabled outside tests | Enable targeted HTTP rate limits |
| `TRUST_PROXY` | `false` | Express proxy trust value/hop count for correct client IPs |

`PUBLIC_DIR` is also recognized by `src/config/paths.js` to override the default `public/` directory. It is mainly useful for controlled hosting/test environments.

### Midtrans

| Variable | Required for payments | Purpose |
| --- | --- | --- |
| `MIDTRANS_URL` | Yes | Snap transactions endpoint |
| `MIDTRANS_AUTH_STRING` | Yes | Base64 encoding of `<server-key>:` for Basic authentication |
| `MIDTRANS_SERVER_KEY` | No | Explicit webhook signing key; otherwise derived from the auth string |

The server starts without these values and logs a warning. Sign-up, activation, and renewal then fail closed. Configure the provider notification URL as `<APP_URL>/api/handle-payment-midtrans`.

### Optional AI

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_ENABLED` | `false` | Master switch |
| `AI_PROVIDER` | `openrouter` | Provider registry key |
| `AI_MODEL` | `openrouter/free` | Provider model/router ID |
| `OPENROUTER_API_KEY` | empty | Backend-only OpenRouter credential |
| `AI_TIMEOUT_MS` | `20000` | Provider timeout, 1,000–120,000 ms |
| `AI_MAX_OUTPUT_TOKENS` | `1200` | Provider response cap, 100–4,000 |
| `AI_USER_COOLDOWN_MS` | `3000` | Minimum delay between one user's requests |
| `AI_USER_MAX_PER_HOUR` | `30` | Per-user hourly cap |
| `AI_GLOBAL_MAX_PER_MINUTE` | `15` | Process-wide per-minute cap |

The configuration reader recognizes `GEMINI_API_KEY`, but the Gemini provider is intentionally not implemented and always reports unavailable. Leave AI disabled unless OpenRouter is configured.

### Demo seed

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEMO_PASSWORD` | `CohortlyDemo123!` | Override the demo account password; it must satisfy the normal policy |

The seed output is the authoritative source for the password used by a run. The comment in `env.example` still names an older default; the executable default comes from `scripts/demo/content.js`.

## npm scripts

| Command | Behavior |
| --- | --- |
| `npm run dev` | Start `src/index.js` with Nodemon |
| `npm start` | Start `src/index.js` with Node |
| `npm test` | Run all test files serially with Node's test runner |
| `npm run seed` | Idempotently ensure categories |
| `npm run seed:demo` | Reset and populate the guarded demo workspace |
| `npm run check:emails` | Report duplicate and mixed-case emails without writing |
| `npm run migrate:content` | Apply the legacy content migration |
| `npm run backfill:paid-at` | Backfill legacy payment confirmation dates |
| `npm run backfill:certificates` | Issue missing certificates for current eligible completions |

Migration and backfill commands accept `-- --dry-run` where documented in [DATABASE.md](DATABASE.md). Review the output and take a database backup before an applying run.

## Testing

```bash
npm test
```

Tests run with `--test-concurrency=1`. They combine:

- pure domain tests for subscription arithmetic, progress, publishing, quiz scoring, context handling, and provider mapping;
- HTTP integration tests through Supertest;
- isolated MongoDB databases through MongoDB Memory Server;
- mocked Midtrans and AI provider calls, so automated tests do not depend on external services;
- upload/security tests using temporary filesystem locations.

Rate limiting is disabled by default under `NODE_ENV=test` and explicitly enabled by the tests that verify it.

There are currently no repository scripts for linting, formatting, static type checking, coverage, or a production build. No CI workflow is checked in.

## Demo workspace

```bash
npm run seed:demo
```

The demo seed:

- ensures categories;
- resets only the reserved demo workspace;
- creates an active instructor, student personas, published/draft courses, progress, attempts, and certificates;
- makes no Midtrans or AI request;
- refuses production-looking targets and unapproved remote databases.

Use [demo-scenarios.md](demo-scenarios.md) for the walkthrough. Re-running the command resets demo changes and creates new certificate numbers.

## Maintenance workflows

### Legacy course content

```bash
npm run migrate:content -- --dry-run
npm run migrate:content
```

The migration copies legacy flat course details into a default section and ordered lessons. It sanitizes copied rich text, preserves legacy rows, and uses `legacyDetailId` to avoid duplicates.

### Legacy payment dates

```bash
npm run backfill:paid-at -- --dry-run
npm run backfill:paid-at
```

Successful legacy transactions without `paidAt` are assigned their last known update time and a one-month period. An old transaction may therefore resolve to `EXPIRED`.

### Historical certificates

```bash
npm run backfill:certificates -- --dry-run
npm run backfill:certificates
```

The script issues certificates only for currently enrolled students who presently satisfy the same published-course completion rule as the API. Its reconstructed issue date is limited by the historical data that exists.

## Troubleshooting

### Startup reports invalid configuration

Confirm the four required variables are non-empty, the JWT secret is at least 16 characters, `PORT` is an integer, and `SUBSCRIPTION_PERIOD_MONTHS` is between 1 and 24.

### Database connection fails

Verify `DATABASE_URL`, start the local MongoDB service if applicable, and confirm network access for a hosted cluster. Connection errors intentionally omit the URI because it may contain credentials.

### Sign-up or checkout returns 503/502

Configure `MIDTRANS_URL` and `MIDTRANS_AUTH_STRING`. A `503` indicates missing configuration; a `502` indicates the provider could not create a checkout.

### Protected routes return inactive-access errors

Authentication and entitlement are separate. A valid instructor may sign in but receive `ACCESS_NOT_ACTIVE`; a student may receive `WORKSPACE_ACCESS_INACTIVE`. Complete or renew the instructor workspace payment.

### AI routes return 503

Ensure `AI_ENABLED=true`, `AI_PROVIDER=openrouter`, and `OPENROUTER_API_KEY` is set. The core LMS continues to function when AI is disabled or unavailable.

### Duplicate email index warning

Run `npm run check:emails`, resolve the reported records manually, and restart the server so the unique index can be synchronized.

### Tests cannot start MongoDB Memory Server

The package may need to download a MongoDB binary on first use. Confirm network/cache permissions and that Node 22+ is active.
