# Cohortly API reference

This document describes the routes registered by `src/app.js` and `src/routes/*.js`. It is a source-verified route reference, not an OpenAPI specification.

## Conventions

- Default local origin: `http://localhost:3000`
- API prefix: `/api`
- Protected request header: `Authorization: JWT <token>`
- JSON responses use `{ "message": string, "data"?: unknown }`.
- Controlled errors use `{ "message": string, "errors"?: [{ "path": string, "message": string }], "code"?: string }`.
- Unknown routes return `404 { "message": "Route not found" }`.
- JSON request bodies are limited to 1 MB.
- Course thumbnails and student avatars use `multipart/form-data`; accepted files are JPEG/PNG up to 2 MB.

### Access labels

| Label | Requirement |
| --- | --- |
| Public | No session token |
| Authenticated | Valid JWT; no active-entitlement requirement |
| Instructor active | Instructor role and active workspace entitlement |
| Student active | Student role and active entitlement inherited from the owning instructor |
| Owned | Resource ownership is derived from stored relations; another instructor's resource returns `404` |
| Enrolled/published | Student is enrolled and the course is published; unavailable courses return `404` |

## Health and identity

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Public | Return `{ status: "ok" }` |
| `POST` | `/api/sign-up` | Public; rate limited | Create an instructor and begin Midtrans activation checkout |
| `POST` | `/api/sign-in` | Public; failed attempts rate limited | Return identity, role, JWT, and current entitlement |
| `GET` | `/api/me` | Authenticated | Return current identity and entitlement |
| `PUT` | `/api/me/password` | Authenticated; failed attempts rate limited | Change the caller's password and invalidate existing tokens |

Request bodies:

```json
// POST /api/sign-up
{ "name": "Rina Hartono", "email": "rina@example.com", "password": "long-password" }

// POST /api/sign-in
{ "email": "rina@example.com", "password": "long-password" }

// PUT /api/me/password
{ "currentPassword": "long-password", "newPassword": "new-long-password" }
```

Instructor sign-up succeeds only when the payment provider creates a hosted checkout URL. On provider failure, the newly created account is removed so registration can be retried.

## Payments and entitlement

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/payment/checkout` | Authenticated instructor | Create or reuse an activation/renewal checkout |
| `POST` | `/api/handle-payment-midtrans` | Valid Midtrans signature | Apply a provider notification to a pending transaction |

The webhook validates its SHA-512 signature and stored amount. Recognized terminal statuses atomically transition only a `pending` transaction. Successful payments set `paidAt`; replays do not extend access twice.

Entitlement values are `NONE`, `PENDING`, `ACTIVE`, `FAILED`, and `EXPIRED`. Instructors use their own payment history; students inherit the entitlement of their owning instructor.

## Instructor dashboard and courses

All routes in this section require an active instructor workspace unless noted.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/overviews` | Instructor-scoped course, student, and lesson totals |
| `GET` | `/api/categories` | List course categories; any authenticated role may call this |
| `GET` | `/api/courses` | List courses owned by the instructor |
| `GET` | `/api/courses/:id` | Read an owned course and ordered outline; `?preview=true` includes lesson content |
| `POST` | `/api/courses` | Create a draft course |
| `PUT` | `/api/courses/:id` | Update course metadata and optional thumbnail |
| `PUT` | `/api/courses/:id/status` | Publish or unpublish a course |
| `DELETE` | `/api/courses/:id` | Delete an owned course and its active learning data |

Course create/update uses `multipart/form-data`:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Minimum 5 characters |
| `categoryId` | MongoDB ObjectId | Must reference an existing category |
| `tagline` | string | Minimum 5 characters |
| `description` | string | Minimum 10 characters |
| `thumbnail` | file | Optional JPEG/PNG, maximum 2 MB |

Every new course starts as `draft`; a client-supplied status is ignored. Publishing requires at least one lesson. If a final quiz exists, it must contain at least one valid question. A published course cannot lose its last lesson until it is unpublished.

## Sections and lessons

All routes require an active instructor, ownership derived through the course, and valid ObjectId parameters.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/courses/:courseId/sections` | Return the ordered course outline |
| `POST` | `/api/courses/:courseId/sections` | Append `{ "title": string }` |
| `PATCH` | `/api/courses/:courseId/sections/reorder` | Reorder using every current `sectionId` exactly once |
| `PUT` | `/api/sections/:sectionId` | Rename a section |
| `DELETE` | `/api/sections/:sectionId` | Delete the section, lessons, progress, and cached summaries |
| `POST` | `/api/sections/:sectionId/lessons` | Append a text or video lesson |
| `PATCH` | `/api/sections/:sectionId/lessons/reorder` | Reorder using every current `lessonId` exactly once |
| `GET` | `/api/lessons/:lessonId` | Read a lesson for management |
| `PUT` | `/api/lessons/:lessonId` | Update title and content; moving between sections is unsupported |
| `DELETE` | `/api/lessons/:lessonId` | Delete a lesson and its dependent progress/summaries |

Section reorder body:

```json
{ "sectionIds": ["...", "..."] }
```

Lesson reorder body:

```json
{ "lessonIds": ["...", "..."] }
```

Text and video lesson bodies are mutually exclusive:

```json
{ "title": "Promises and async/await", "type": "text", "text": "<p>...</p>" }
```

```json
{ "title": "Event loop walkthrough", "type": "video", "youtubeId": "dQw4w9WgXcQ" }
```

## Students and enrollment

All routes require an active instructor. Students are scoped to the instructor stored in `User.manager`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/students` | List the instructor's students |
| `GET` | `/api/students/:id` | Read an owned student |
| `POST` | `/api/students` | Create a student with a required avatar |
| `PUT` | `/api/students/:id` | Update identity, optional password, and optional avatar |
| `DELETE` | `/api/students/:id` | Delete a student and active learning records |
| `GET` | `/api/courses/students/:id` | List students enrolled in an owned course |
| `POST` | `/api/courses/students/:id` | Enroll `{ "studentId": ObjectId }` |
| `PUT` | `/api/courses/students/:id` | Unenroll `{ "studentId": ObjectId }` |

Student create/update uses `multipart/form-data` with `name`, `email`, `password`, and the `avatar` file field. The avatar is required on create. Password and avatar are optional on update; supplying a new password invalidates that student's existing JWTs.

Unenrollment deletes the student's progress and quiz attempts for that course. Re-enrollment starts from zero. Previously issued certificates are retained.

## Student learning and progress

Student routes require the student role, active inherited workspace entitlement, enrollment, and a published course. Instructor progress requires an active instructor and course ownership.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/students-courses` | Student active | List enrolled, published courses with derived state |
| `GET` | `/api/students-courses/:courseId` | Student; enrolled/published | Read course outline, progress, quiz state, and next activity |
| `GET` | `/api/students-courses/:courseId/lessons/:lessonId` | Student; enrolled/published | Read lesson content, completion, and navigation |
| `PUT` | `/api/lessons/:lessonId/completion` | Student; enrolled/published | Idempotently mark a lesson complete |
| `DELETE` | `/api/lessons/:lessonId/completion` | Student; enrolled/published | Idempotently remove lesson completion |
| `GET` | `/api/courses/:courseId/progress` | Instructor active; owned | Report progress, quiz state, and certificate state for enrolled learners |

Lesson percentage is `floor(completedLessons × 100 / totalLessons)`. Course completion additionally requires a passing final quiz when one exists. Progress is calculated from completion and attempt records; no percentage is stored.

## Final quizzes

### Instructor management

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/courses/:courseId/quiz` | Return the quiz and answer key, or `data: null` |
| `POST` | `/api/courses/:courseId/quiz` | Create the course's single final quiz |
| `PUT` | `/api/quizzes/:quizId` | Update title and passing score |
| `DELETE` | `/api/quizzes/:quizId` | Delete the quiz; keep attempts and certificates as history |
| `POST` | `/api/quizzes/:quizId/questions` | Append a question |
| `PATCH` | `/api/quizzes/:quizId/questions/reorder` | Reorder every question exactly once |
| `PUT` | `/api/quizzes/:quizId/questions/:questionId` | Update a question and its options |
| `DELETE` | `/api/quizzes/:quizId/questions/:questionId` | Delete a question and normalize order |

Quiz settings:

```json
{ "title": "Final assessment", "passingScore": 70 }
```

Question input:

```json
{
  "prompt": "Which value is immutable?",
  "options": [
    { "text": "A string", "isCorrect": true },
    { "text": "An array", "isCorrect": false }
  ]
}
```

Existing option IDs may be supplied during an update to preserve stable identity. Options must contain 2–8 distinct values and exactly one correct answer.

### Student assessment

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/students-courses/:courseId/quiz` | Return questions and options without correctness data |
| `POST` | `/api/students-courses/:courseId/quiz/attempts` | Validate and score one answer per question |
| `GET` | `/api/students-courses/:courseId/quiz/attempts` | Return only the caller's attempt history |

Attempt input:

```json
{
  "answers": [
    { "questionId": "...", "optionId": "..." }
  ]
}
```

The server ignores client-supplied score, correctness, pass/fail, or passing-score fields. A quiz is unavailable until all lessons are complete and the quiz is structurally ready. Attempts are immutable history; a later failed retry does not remove an earlier pass.

## Certificates

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/my-certificates` | Authenticated student | List the student's certificates |
| `GET` | `/api/my-certificates/:certificateNumber` | Authenticated student | Read an owned certificate |
| `GET` | `/api/certificates/verify/:certificateNumber` | Public; rate limited | Verify printed fields only |

Private certificate reads intentionally do not require an active workspace. Public verification exposes only validity, certificate number, student name, course name, instructor name, and issue date. It does not expose email addresses, internal IDs, attempts, payment state, or scores.

## Optional AI routes

`GET /api/ai/status` reports configuration without calling a provider. The remaining routes require `AI_ENABLED=true`, a configured provider, and the same authorization gates as the underlying lesson or course.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/ai/status` | Authenticated | Return enabled/available/provider state |
| `POST` | `/api/students-courses/:courseId/lessons/:lessonId/ai/question` | Student; enrolled/published | Answer `{ "question": string }` from lesson text |
| `POST` | `/api/students-courses/:courseId/lessons/:lessonId/ai/summary` | Student; enrolled/published | Generate or reuse a lesson summary |
| `POST` | `/api/students-courses/:courseId/lessons/:lessonId/ai/practice` | Student; enrolled/published | Generate temporary practice questions |
| `POST` | `/api/courses/:courseId/quiz/ai-draft` | Instructor active; owned | Generate `{ "count": 1..10, "focus"?: string }` |

Questions, practice sets, and quiz drafts are not stored. Quiz drafts do not modify an existing quiz and must be applied through the normal validated quiz routes. Summaries alone are cached by lesson content hash, provider, and model.

## Common errors

| Status | Meaning |
| --- | --- |
| `400` | Invalid body, identifier, upload, amount, or answer set |
| `401` | Missing, malformed, expired, or invalidated JWT |
| `403` | Wrong role, inactive entitlement, or invalid webhook signature |
| `404` | Missing/unavailable resource, including foreign ownership |
| `409` | Duplicate/conflicting resource, locked/not-ready quiz, or published-course invariant |
| `413` | JSON/upload/AI context exceeds its configured limit |
| `422` | Course cannot publish or AI has insufficient text context |
| `429` | Route or AI usage limit exceeded |
| `500` | Unexpected internal error with details suppressed |
| `502` | Invalid/unusable AI response or upstream payment failure |
| `503` | Payment/AI provider disabled, unconfigured, or unavailable |

AI failures use stable codes including `AI_DISABLED`, `AI_NOT_CONFIGURED`, `AI_PROVIDER_UNAVAILABLE`, `AI_RATE_LIMITED`, `AI_RESPONSE_INVALID`, `AI_CONTEXT_TOO_LARGE`, and `AI_NO_TEXT_CONTEXT`.
