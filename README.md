# LMS backend

Express 4 + MongoDB (Mongoose) API for the B2B learning platform.

Product roles are **INSTRUCTOR** and **STUDENT**. For now the database still
stores the instructor role as `manager` (see `src/utils/roles.js`).

## Requirements

- Node.js 22+ (the test script relies on the built-in test runner's glob support)
- A running MongoDB 4.x or newer (local `mongod`, Docker, or Atlas)

## Fresh setup

```bash
npm install
cp env.example .env        # then fill in the values (see comments in the file)
npm run seed               # categories (safe to run repeatedly)
npm run seed:demo          # optional: + demo instructor/student (never in production)
npm run dev                # or: npm start
```

Required variables: `DATABASE_URL`, `SECRET_KEY_JWT` (16+ chars), `APP_URL`,
`FRONTEND_URL`. The server refuses to start and lists what is missing.
Upload folders (`public/uploads/courses|students`) are created automatically.

Demo accounts from `npm run seed:demo` (password `demo-password-123`, or `DEMO_PASSWORD`):
`instructor@demo.local` and `student@demo.local`. The demo workspace is granted one
subscription period without payment; re-running the seed after it ended grants a new one.

## Scripts

| Script | Purpose |
|---|---|
| `npm test` | Node test runner + supertest on an in-memory MongoDB (no real Midtrans calls) |
| `npm run seed` / `seed:demo` | Idempotent bootstrap |
| `npm run check:emails` | Read-only report of duplicate emails already in the database |
| `npm run migrate:content -- --dry-run` | Moves legacy flat course content into sections/lessons (idempotent, never deletes legacy data) |
| `npm run backfill:certificates -- --dry-run` | Reports (then, without the flag, issues) certificates for students who already completed a course before certificates existed. Idempotent, never runs at startup (see [Certificates](#certificates)) |
| `npm run backfill:paid-at -- --dry-run` | Reports (then, without the flag, persists) the payment time of legacy successful transactions. Idempotent, never creates or deletes payments |

The first `npm test` downloads a MongoDB binary (cached afterwards).

## Subscription model (B2B, monthly, manual renewal)

An instructor registers for a workspace and pays for access. **One successful payment buys
one subscription period (default: 1 calendar month).** Instructors and the students they
create share one workspace entitlement.

**M3A does not implement provider-side automatic recurring billing.** There is no stored card,
no automatic charge and no background job. Renewal is manual: the instructor pays again
through the same hosted Midtrans page.

### Payment status vs. access state

Two different things:

- **Transaction status** (a payment record): `pending | success | failed`.
- **Access state** (the workspace entitlement, derived from the transactions):

| Access state | Meaning |
|---|---|
| `ACTIVE` | a paid period covers the current time |
| `PENDING` | not active, and the latest payment is still open |
| `FAILED` | not active, and the latest payment failed |
| `EXPIRED` | not active, and the latest payment succeeded but its period has ended |
| `NONE` | no payment was ever started (students without a valid instructor are also `NONE`) |

`ACTIVE` is decided first and only from successful payments, so a pending or failed *renewal*
never shortens or ends access that is still valid.

### Periods

- First payment (or payment after expiry): the period starts when the payment is confirmed
  (`paidAt`) and ends one calendar month later.
- Renewal while still `ACTIVE`: the new period starts at the current expiry. Paid time is
  never lost or shortened.
- Calendar months: same day and time of day (UTC) in the target month, clamped to the last day
  of shorter months (31 Jan + 1 month = 28/29 Feb). Never 30-day arithmetic.
- The period length of an order is fixed when the order is created
  (`SUBSCRIPTION_PERIOD_MONTHS`, default `1`), so changing the setting never changes a payment
  that is already open.
- Expiry is a pure function of time (`now >= accessExpiresAt`). Nothing is scheduled or rewritten
  when access ends.

### Hard entitlement

Authentication and entitlement are separate. A user with valid credentials can always sign in,
even when access is inactive; the response says what the access state is.

| Endpoint group | Requires ACTIVE workspace |
|---|---|
| Instructor management (courses, content, students, enrollment, overview) | yes → `403 ACCESS_NOT_ACTIVE` |
| Student learning (`/students-courses`, enrolled course detail) | yes, the **instructor's** workspace → `403 WORKSPACE_ACCESS_INACTIVE` |
| `POST /api/sign-in`, `GET /api/me`, `POST /api/payment/checkout`, `GET /api/categories`, `GET /api/health` | no (identity and payment recovery) |

Blocked responses look like
`{ "message": "...", "code": "WORKSPACE_ACCESS_INACTIVE", "accessStatus": "EXPIRED", "accessExpiresAt": "..." }`.

A student's entitlement is **derived** from `User.manager` (their instructor) on every request and is never
copied onto the student. A student whose instructor is missing, deleted or not an instructor is treated as
`NONE` (blocked).

`GET /api/me` and `POST /api/sign-in` return `accessStatus`, `accessStartsAt`, `accessExpiresAt`
(for students: the instructor workspace's). The dates are `null` until a payment succeeded and stay
available after expiry.

### Payments (Midtrans)

1. `POST /api/sign-up` creates the instructor + a pending *activation* order, calls Midtrans and
   returns `data.midtrans_payment_url`. If Midtrans fails, the new records are removed and
   the API answers `502` so the sign-up can be retried.
2. `POST /api/payment/checkout` (instructors only, any access state) starts payment for one more
   period. Response: `midtrans_payment_url`, `purpose` (`activation` first time, `renewal` once the
   instructor has paid before), `reused`, `accessStatus`, `accessExpiresAt`. A recent pending page
   (20 minutes) is reused instead of creating a new order. Early renewal while `ACTIVE` is allowed.
3. Midtrans calls `POST /api/handle-payment-midtrans`. The notification is accepted only if
   its `signature_key` (SHA512 of `order_id + status_code + gross_amount + server key`) is
   valid and the amount matches. The server key is derived from `MIDTRANS_AUTH_STRING`
   (or set `MIDTRANS_SERVER_KEY`). Not configured = every notification is rejected.
4. **Idempotency:** a payment moves `pending → success|failed` with one atomic conditional update.
   Only the request that wins it sets `paidAt`; the access period is derived from `paidAt`. A replayed,
   concurrent or late notification matches nothing, so it cannot add a second period, reset the start, or
   revive a failed payment.

Local testing limitation: real notifications need a publicly reachable `/api/handle-payment-midtrans`
URL configured in the Midtrans dashboard, and Midtrans sandbox credentials. Without them, use
`npm run seed:demo` for an active workspace, and the test suite, which mocks the provider and signs
notifications itself.

### Legacy data

Transactions created before M3A have no `paidAt`/`periodMonths`. They are interpreted as one period starting at the
record's last write (`updatedAt`), so nobody keeps unlimited access from an old payment. `npm run backfill:paid-at`
persists exactly that interpretation (use `-- --dry-run` first). Instructors whose old payment is more than one period
old are `EXPIRED` and renew through `POST /api/payment/checkout`.

## Course structure and learning progress

```
Course ──► Section ──► Lesson            (instructor builds, ordered explicitly)
   │                      │
   └── students           └── LessonProgress (student + lesson + completedAt)   ← the only progress data
```

- **Course** (name, tagline, description, thumbnail, category, owner, enrolled students, `status`).
- **Section** (`course`, `title`, `order`) and **Lesson** (`course`, `section`, `title`, `type` `text|video`,
  `text` *or* `youtubeId`, `order`). There is no deeper nesting. A lesson cannot move to another section;
  use reorder within a section.
- **Order** is explicit: sections ascending by `order`, lessons ascending by `order` within their section, ties
  broken by `_id`. New sections/lessons are appended. Reordering is one operation that must list every child
  exactly once (`400 REORDER_MISMATCH` otherwise) and rewrites positions to `0..n-1`. It is one ordered bulk
  write; MongoDB gives no multi-document atomicity on a standalone server, so a crash mid-write leaves a valid
  but possibly half-old order, and repeating the request repairs it.
- **Lesson content:** TEXT lessons store sanitized rich text (same policy as before) and no `youtubeId`;
  VIDEO lessons store a validated YouTube id and no text.

### Draft / published

Courses start as `draft`. Instructors always see and manage their own courses. Students can learn only from a
course that is **published**, **enrolled** and whose instructor workspace is **ACTIVE**; anything else is a `404`
(or `403 WORKSPACE_ACCESS_INACTIVE` when the workspace is inactive). Publishing requires at least one lesson
(`422 COURSE_NOT_PUBLISHABLE` otherwise); sections without lessons are allowed but hidden from students.
A published course must **keep** at least one lesson: deleting its last lesson, or a section holding its last lessons,
is refused with `409 PUBLISHED_COURSE_INVARIANT` (unpublish first; drafts can be emptied freely). The rule lives in
`services/publishing.js`.
Unpublishing is always allowed, removes student access at once and **keeps all progress**.
Enrolled students of a draft course are left out of their dashboard.

### Progress is derived, never stored

For one student and one course (always computed from current lessons and completion records):

| Value | Definition |
|---|---|
| `totalLessons` | lessons currently in the course |
| `completedLessons` | those with a completion record |
| `percent` | integer 0-100, **rounded down** (`100` means exactly complete); `0` when there are no lessons |
| `completed` | `totalLessons > 0 && completedLessons === totalLessons` |
| `nextLesson` | first lesson in section/lesson order without a completion, or `null` |

Course completion is therefore not a stored flag. Adding a lesson re-opens a completed course, deleting a lesson
recalculates from what remains, and undoing a completion re-opens it.
One completion per student and lesson is enforced by a unique index.
Completing is idempotent (`PUT`) and so is undoing (`DELETE`); both return the new `progress` and `nextLesson`.

### Deletes

| Delete | Also deletes |
|---|---|
| Lesson | its completion records |
| Section | its lessons and their completion records |
| Course | its sections, lessons, completion records, **final quiz and quiz attempts**; enrollment links. **Certificates are kept** |
| Student | their enrollments, progress and quiz attempts. **Their certificates are kept** (see the policy below) |
| Unenroll a student | that student's progress and quiz attempts in that course (they belong to the enrollment; re-enrolling starts at zero). **The certificate is kept** |

### Endpoints

Instructor (INSTRUCTOR role, ACTIVE workspace, owned course; foreign resources are `404`):

| Method and path | Purpose |
|---|---|
| `GET /api/courses/:id` | course with its ordered sections and lessons (`?preview=true` adds lesson content) |
| `PUT /api/courses/:id/status` | `{ "status": "draft" \| "published" }` |
| `GET/POST /api/courses/:courseId/sections` | list / create (appended) |
| `PATCH /api/courses/:courseId/sections/reorder` | `{ "sectionIds": [...] }` |
| `PUT/DELETE /api/sections/:sectionId` | rename / delete with its lessons |
| `POST /api/sections/:sectionId/lessons` | create lesson (appended) |
| `PATCH /api/sections/:sectionId/lessons/reorder` | `{ "lessonIds": [...] }` |
| `GET/PUT/DELETE /api/lessons/:lessonId` | read / update / delete lesson |
| `GET /api/courses/:courseId/progress` | every enrolled learner: counts, percent, completed, next lesson, last activity |

Student (STUDENT role, ACTIVE instructor workspace, enrolled and published course):

| Method and path | Purpose |
|---|---|
| `GET /api/students-courses` | dashboard: each published enrolled course with `progress` and `nextLesson` |
| `GET /api/students-courses/:courseId` | learning view: ordered sections/lessons with `completed`, `progress`, `nextLesson` |
| `GET /api/students-courses/:courseId/lessons/:lessonId` | one lesson with content and previous/next ids |
| `PUT /api/lessons/:lessonId/completion` | mark complete (idempotent) |
| `DELETE /api/lessons/:lessonId/completion` | undo (idempotent) |

The old flat content endpoints (`/api/courses/contents...`) and student access to `GET /api/courses/:id` were removed.

### Migrating legacy content

Existing courses stored flat `CourseDetail` rows. After deploying, run once:

```bash
npm run migrate:content -- --dry-run   # report only
npm run migrate:content                # apply
```

Each course with legacy content gets one section "Course Content" with its lessons in the original order
(rich text is sanitized while copying). Each lesson remembers its source row (`legacyDetailId`, unique), so reruns
create nothing twice. Legacy courses have no status: those with content become `published` (students keep access),
empty ones `draft`. **Until the migration has run, migrated-to-be courses are invisible to students.**
The script never modifies or deletes legacy data. When it reports `0 mismatch(es)` and you have a backup, the
unused legacy data can be dropped manually: `db.coursedetails.drop()` and
`db.courses.updateMany({}, { $unset: { details: "" } })`.

### Indexes

| Collection | Index | Why |
|---|---|---|
| sections | `{course, order}` | ordered sections of a course |
| lessons | `{section, order}`, `{course}` | ordered lessons of a section; per-course counts and cascades |
| lessons | unique `{legacyDetailId}` (only where set) | idempotent migration |
| lessonprogresses | unique `{student, lesson}` | one completion per student and lesson |
| lessonprogresses | `{student, course}`, `{course}` | student dashboard; instructor reporting |
| courses | `{manager}`, `{students, status}` | instructor course list; student dashboard |
| quizzes | unique `{course}` | one final quiz per course, also enforced by the database |
| quizattempts | `{student, quiz, submittedAt}`, `{quiz, student}`, `{course}` | a student's history and "has passed"; instructor reporting; course cascade |
| certificates | unique `{certificateNumber}`, unique `{student, course}`, `{student, issuedAt}` | public lookup; one certificate per student and course (makes issuance idempotent); "my certificates" |

## Final quiz, course completion and certificates (M8)

### The model

```
Course
├── Section
│   └── Lesson
├── Quiz                (at most ONE per course: unique index)
│   └── questions[]     embedded
│       └── options[]   embedded, each with a stable id
├── QuizAttempt         (history: one document per submitted attempt)
└── Certificate         (an issued, historical record)
```

- **Quiz** `{ course, title, passingScore (1-100, default 70), questions[] }`. One quiz per course.
- **Questions and options are embedded** in the quiz, not separate collections: a quiz is small (tens of questions), is always
  read and written as a unit, is never queried by question, and an embedded document is updated atomically with its parent.
- **Stable ids.** Every question and option has its own `_id`. Students answer with ids, never with array positions, so editing,
  adding or reordering never changes what an id means. A question stores its answer as `correctOption` (an option id), so
  "exactly one correct option" is true by construction. Question order is an explicit `order` (0..n-1).
- **Single-answer multiple choice only.** 2 to 8 options, exactly one correct, option texts distinct. No timers, pools, essays or limits.
- **QuizAttempt** `{ quiz, course, student, answers[{question, option, correct}], totalQuestions, correctAnswers, score, passingScore, passed, submittedAt }`.
  An attempt is never edited: a retry is a new document. It remembers the passing score of its time.
- **Certificate** `{ student, course, certificateNumber, studentName, courseName, instructorName, totalLessons, finalScore, issuedAt }`.

### Course completion: one rule, one place

`utils/progress.js` `summarizeProgress` is the only place that decides completion:

| Course | `progress.completed` |
|---|---|
| **without** a final quiz | `totalLessons > 0` and every lesson completed (exactly the old rule: existing courses are unaffected) |
| **with** a final quiz | `totalLessons > 0` and every lesson completed **and** a passing attempt exists |

`progress.percent` stays the **lesson** percentage: a missing or failed quiz never turns 100 into 99. Student-facing endpoints get
the whole picture from `services/learning.js` `studentCourseState`:

| Field | Meaning |
|---|---|
| `progress` | `{ completedLessons, totalLessons, percent, completed }` (`completed` = the authoritative course completion above) |
| `nextLesson` | unchanged: the first incomplete lesson or `null` |
| `nextActivity` | `{ type: "lesson", ... }` while lessons remain, `{ type: "quiz", quizId, title, state }` when only the quiz is left, otherwise `null` |
| `quiz` | `null`, or `{ _id, title, totalQuestions, passingScore, state, passed, attempts, latestAttempt, bestScore }`; `state` is `locked`, `not-ready`, `available` or `passed` |
| `certificate` | `null`, or `{ certificateNumber, issuedAt }` |

These are returned by `GET /api/students-courses`, `GET /api/students-courses/:courseId` and the completion endpoints. The instructor
progress endpoint reports each learner's lessons and quiz **separately** (`progress`, `quiz: { status: not-started|failed|passed, attempts, latestScore, bestScore }`,
`certificateIssued`) and never merges them into one number.

### Quiz availability (no separate quiz "draft")

A student can take the quiz when **all** of these hold, otherwise the call is refused without revealing anything:

1. STUDENT role and an ACTIVE instructor workspace (`403 WORKSPACE_ACCESS_INACTIVE` otherwise);
2. enrolled in the course and the course is `published` (otherwise the usual `404`);
3. the course has a quiz (`404 QUIZ_NOT_FOUND`);
4. the quiz is **ready**: at least one question, each with 2+ options and one correct option, valid passing score (`409 QUIZ_NOT_READY`);
5. every lesson is completed (`409 QUIZ_LOCKED`).

There is no quiz publication state: availability is course publication plus quiz validity. A quiz that exists but is not ready can
neither be taken nor passed, so nobody can complete the course or be certified while an instructor is still building it.
**Publishing a course** with an unfinished quiz is refused: `422 QUIZ_NOT_READY` (with `problems`); a course without a quiz publishes as before.

### Scoring and attempts

`score = floor(correctAnswers * 100 / totalQuestions)`: an integer 0-100 with equal weight per question, rounded **down**, so 100 means
every answer was right (2 of 3 is 66, not 67). `passed = score >= passingScore` at the moment of submission.
**Every question must be answered exactly once** with an option of that question; missing, duplicate, unknown, extra or foreign options and
malformed ids are `400` and store nothing. The client sends **only** `{ answers: [{ questionId, optionId }] }`; any score, `passed`, correctness
or passing score in the body is ignored. Retries are unlimited and each is stored. Once a passing attempt exists the quiz stays passed:
a later lower score never takes it away. The submit response contains the attempt, `results: [{ questionId, correct }]` (right/wrong only, never
which option was right), `courseCompleted`, `certificateIssued`, and the new `progress`, `nextActivity`, `quiz`, `certificate`.

### Answer keys never reach a student

`utils/quiz.js` `presentQuizForStudent` builds its response from an explicit whitelist (`_id`, `title`, `passingScore`, `totalQuestions`, question
`_id`/`prompt`/`order`, option `_id`/`text`); it never spreads a document. The only function that reveals the correct option is
`presentQuizForInstructor`, used by the management endpoints (instructor, owned course). Tests assert that no student-facing response contains
`correct` fields.

### Endpoints (M8)

Instructor (INSTRUCTOR role, ACTIVE workspace, owned course; foreign resources are `404`, students `403`):

| Method and path | Purpose |
|---|---|
| `GET /api/courses/:courseId/quiz` | the quiz as the instructor edits it (answer key, `ready`, `problems`), or `data: null` |
| `POST /api/courses/:courseId/quiz` | create `{ title, passingScore }` (`409 QUIZ_EXISTS` if there is one) |
| `PUT/DELETE /api/quizzes/:quizId` | update title and passing score / delete the quiz |
| `POST /api/quizzes/:quizId/questions` | add `{ prompt, options: [{ id?, text, isCorrect }] }` |
| `PUT/DELETE /api/quizzes/:quizId/questions/:questionId` | update (options that carry their `id` keep it) / delete |
| `PATCH /api/quizzes/:quizId/questions/reorder` | `{ "questionIds": [...] }` (the complete list; `REORDER_MISMATCH` otherwise) |
| `GET /api/courses/:courseId/progress` | now also `quiz` (course), per-learner `quiz` and `certificateIssued`, `summary.certificatesIssued` |

Student (STUDENT role, ACTIVE workspace, enrolled and published course):

| Method and path | Purpose |
|---|---|
| `GET /api/students-courses/:courseId/quiz` | the quiz to answer (no answer key); `409 QUIZ_LOCKED` / `QUIZ_NOT_READY` |
| `POST /api/students-courses/:courseId/quiz/attempts` | submit `{ answers }`; returns the scored attempt and the new course state |
| `GET /api/students-courses/:courseId/quiz/attempts` | the student's **own** attempts, oldest first |

Certificates:

| Method and path | Access | Purpose |
|---|---|---|
| `GET /api/my-certificates`, `GET /api/my-certificates/:certificateNumber` | STUDENT, **no active-workspace requirement** | the student's own certificates (another student's is `404`) |
| `GET /api/certificates/verify/:certificateNumber` | **public** | verification: only `valid`, `certificateNumber`, `studentName`, `courseName`, `instructorName`, `issuedAt`; unknown or malformed numbers are `404 { valid: false }` |

### Certificates

**Issuance.** A certificate is issued exactly when a student **enrolled** in a **published** course is course-complete by the rule above: on the last
lesson of a course without a quiz, or on the passing quiz attempt. A draft course never issues a new certificate. After an instructor deletes a
lesson, a section or the quiz (which can complete a course for people who were waiting), and when a course is published, the certificates that
became due are issued too. `services/certificates.js` reads `studentCourseState`: it re-implements nothing.
**Idempotent:** the unique `{student, course}` index decides; a repeated or concurrent call that loses the race gets the winner's certificate
(tested with 8 to 12 simultaneous requests). Retrying the quiz, undoing and redoing a lesson, or later completions never create a second one.

**Number.** `COH-<year>-<8 random characters>` from an alphabet without 0/O/1/I/L/U (about 39 bits from `crypto.randomBytes`): no personal data, no sequence, no database id. The unique index
catches a collision and the issuer simply draws another. The number, names, lesson count and `issuedAt` are `immutable`.

**Snapshots.** `studentName`, `courseName` and `instructorName` are copied at issuance, so renaming the course or either account never rewrites a
certificate that was already issued, and it stays verifiable after the course is gone.

**Historical policy.** A certificate records that a course was completed *at that time*. It is never recomputed or revoked:
adding a lesson later, adding or editing the quiz, raising the passing score, undoing a lesson, a lower later quiz score or unpublishing the course
do not touch it. The *live* course progress may become incomplete again; the certificate stays valid.

**Entitlement.** Quiz endpoints need an ACTIVE workspace like every learning endpoint. An issued certificate is a historical record, not
learning content, so a student can still read **their own** certificates while the workspace is inactive; **public verification never needs a session**.

**Deletion policy.** Deleting a quiz or a question keeps attempts and certificates. Deleting a course deletes its quiz and attempts (learning data) but
**keeps its certificates**. Deleting a student deletes their progress and attempts and **keeps their certificates** (an issued record, verifiable by number; the snapshot
keeps the name that was printed). If you must erase a person completely, remove their certificates by hand; there is no endpoint for that on purpose.

**Backfill.** `npm run backfill:certificates -- --dry-run` reports, and without the flag issues, certificates for enrollments that **currently** satisfy the rule and
have none (courses completed before certificates existed). It never runs automatically, is idempotent, and prints a summary. `issuedAt` is the later of the student's most recent
lesson completion and their first passing attempt. Limits: lesson progress only reflects the present (a lesson that was undone and completed again moves the date), so the
date is a defensible reconstruction, not a historical fact; draft courses are skipped (their certificates are issued when they are published).

## Auth, authorization and access are separate

- **Authentication** – `Authorization: JWT <token>`. Any failure is `401`.
- **Authorization** – role (`INSTRUCTOR`/`STUDENT`) and ownership. Wrong role is `403`;
  someone else's resource is `404`.
- **Access state** – whether the workspace subscription is currently paid (above).

## AI learning assistant (M9, optional)

AI is an **optional layer**. Authentication, authorization, subscriptions, lesson progress, quiz scoring, pass/fail, completion and certificates never depend on it and never ask it anything. With AI disabled, the key missing, the provider down or the quota exhausted, the whole LMS keeps working; only the AI buttons say "temporarily unavailable" or disappear.

**Architecture:** controller -> `aiService` -> provider registry -> provider. OpenRouter is the primary provider; `geminiProvider` is a recognised extension point that currently reports `AI_NOT_CONFIGURED` (implement `generate()` and `isConfigured()` against the contract in that file, then register it). Adding a provider needs no change to `aiService`, controllers or the frontend.

**Configuration** (see `env.example`; the key lives only on the backend and is never sent to the browser or logged):

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_ENABLED` | `false` | master switch |
| `AI_PROVIDER` | `openrouter` | `openrouter` (or `gemini` once implemented) |
| `AI_MODEL` | `openrouter/free` | model or router id |
| `OPENROUTER_API_KEY` | empty | secret, backend only |
| `AI_TIMEOUT_MS` | `20000` | provider timeout |
| `AI_MAX_OUTPUT_TOKENS` | `1200` | response size cap |
| `AI_USER_COOLDOWN_MS` | `3000` | minimum gap between one user's requests |
| `AI_USER_MAX_PER_HOUR` | `30` | per-user cap |
| `AI_GLOBAL_MAX_PER_MINUTE` | `15` | global cap (protects free-tier quota) |

To disable AI: leave `AI_ENABLED=false` (or unset the key). `GET /api/ai/status` reports `{ enabled, available, provider }` without calling the provider and without secrets.

**Endpoints** (students need an ACTIVE workspace entitlement, instructors must own the course):
- `POST /api/students-courses/:courseId/lessons/:lessonId/ai/question` `{ question }`
- `POST /api/students-courses/:courseId/lessons/:lessonId/ai/summary`
- `POST /api/students-courses/:courseId/lessons/:lessonId/ai/practice` (4 local-only practice questions, Zod-validated)
- `POST /api/courses/:courseId/quiz/ai-draft` `{ count, focus }` (a draft only: nothing is saved; the instructor applies it through the existing M8 quiz endpoints)

**Privacy / context.** Only the current lesson's text (students) or the owned course's text (instructors) is sent, plus the question. Never sent: passwords, JWTs, payment data, certificates, other students' data, ids, emails, instructor private data. System prompts, model and limits are backend-owned; the client cannot inject any. Lesson text is wrapped as data and tag look-alikes are neutralised (prompt-injection boundary). Video lessons have no transcript, so the AI declines them instead of guessing. No student conversations are stored; logs contain feature, provider, ok/code and latency only.

**Errors** are normalised: `AI_DISABLED`, `AI_NOT_CONFIGURED`, `AI_PROVIDER_UNAVAILABLE`, `AI_RATE_LIMITED`, `AI_RESPONSE_INVALID`, `AI_CONTEXT_TOO_LARGE` (plus `AI_NO_TEXT_CONTEXT`).

**Decisions.** Summaries are cached (`AiSummary`, keyed by lesson + content hash + provider + model, no personal data, invalidated by content change, removed in cascades); questions, practice and drafts are not stored. No streaming. No RAG or vector database. Free-tier models can be slow, rate-limited or malformed, hence one retry on invalid output and strict validation. **Limitation:** the usage limiter is in-memory, so it is per process; run a shared store (e.g. Redis) before scaling to several instances.
