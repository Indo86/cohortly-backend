import mongoose from "mongoose";
import { z } from "zod";

const objectId = (label = 'id') =>
    z.string().refine((value) => mongoose.isValidObjectId(value), { message: `Invalid ${label}` })

const email = z.string().trim().toLowerCase().email()

// The password policy for every NEW password (sign-up, a student created or edited by the instructor;
// M3's change-password will reuse it). Length over complexity rules: at least 8 characters, at most 72
// because bcrypt only uses the first 72 bytes (longer passwords are rejected instead of silently
// truncated). Existing accounts keep working: sign-in only checks the stored hash.
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 72

export const passwordSchema = z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Use a password of at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(PASSWORD_MAX_LENGTH, `Use a password of at most ${PASSWORD_MAX_LENGTH} characters`)

const password = passwordSchema

export const signUpSchema = z.object({
    name: z.string().trim().min(5),
    email,
    password
})

// The signed-in user's own password change. The new password follows the policy and must differ from
// the current one (unknown keys, e.g. a user id, are stripped: the account always comes from the token).
export const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: passwordSchema
}).superRefine((value, ctx) => {
    if (value.newPassword === value.currentPassword) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose a new password that is different from the current one', path: ['newPassword'] })
    }
})

export const signInSchema = z.object({
    email,
    password: z.string().min(1)
})

export const mutateCourseSchema = z.object({
    name: z.string().trim().min(5),
    categoryId: objectId('categoryId'),
    tagline: z.string().trim().min(5),
    description: z.string().trim().min(10)
})

const YOUTUBE_ID = /^[A-Za-z0-9_-]{4,64}$/

export const sectionSchema = z.object({
    title: z.string().trim().min(3)
})

// Lesson create/update body. The course and section come from the URL, never the body,
// and a lesson cannot be moved to another section through an update.
export const lessonSchema = z.object({
    title: z.string().trim().min(5),
    type: z.enum(['video', 'text']),
    youtubeId: z.string().optional(),
    text: z.string().optional()
}).superRefine((val, ctx) => {
    if (val.type === 'video' && !YOUTUBE_ID.test(val.youtubeId ?? '')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Youtube ID is required', path: ['youtubeId'] })
    }

    if (val.type === 'text' && (val.text ?? '').trim().length < 4) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Content Text is required', path: ['text'] })
    }
})

// Reorder bodies must list every child exactly once; the controller also checks
// that the ids are exactly the current children of the parent.
const uniqueIds = (label) =>
    z.array(objectId(label)).min(1).refine((ids) => new Set(ids).size === ids.length, {
        message: 'Duplicate ids are not allowed'
    })

export const reorderSectionsSchema = z.object({ sectionIds: uniqueIds('sectionId') })
export const reorderLessonsSchema = z.object({ lessonIds: uniqueIds('lessonId') })

export const courseStatusSchema = z.object({
    status: z.enum(['draft', 'published'])
})

export const mutateStudentSchema = z.object({
    name: z.string().trim().min(5),
    email,
    password
})

// A missing, empty or stringified-undefined/null password means "do not change it".
// ("undefined"/"null" are what a FormData.append(undefined) produces; the existing
// frontend sends them on every student edit.)
export const updateStudentSchema = z.object({
    name: z.string().trim().min(5),
    email,
    password: z.preprocess(
        (value) =>
            value === '' || value === 'undefined' || value === 'null' || value === null
                ? undefined
                : value,
        password.optional()
    )
})

export const addStudentCourseSchema = z.object({
    studentId: objectId('studentId')
})

// ---- final quiz ------------------------------------------------------------------------
// Unknown keys are stripped (zod default), so nothing such as a client-supplied score, passed
// flag or correctness can reach a handler.

export const quizSettingsSchema = z.object({
    title: z.string().trim().min(3).max(120),
    passingScore: z.number().int().min(1).max(100).default(70)
})

// A question as the instructor edits it: the options in their order, exactly one flagged
// isCorrect. An option that already exists keeps its stable `id`; new options have none.
const optionInput = z.object({
    id: objectId('option id').optional(),
    text: z.string().trim().min(1, 'Option text is required').max(500),
    isCorrect: z.boolean()
})

export const quizQuestionSchema = z.object({
    prompt: z.string().trim().min(3, 'Question text is required').max(1000),
    options: z.array(optionInput).min(2, 'A question needs at least 2 options').max(8, 'A question can have at most 8 options')
}).superRefine((value, ctx) => {
    const correct = value.options.filter((option) => option.isCorrect).length

    if (correct !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mark exactly one option as correct', path: ['options'] })
    }

    const ids = value.options.map((option) => option.id).filter(Boolean)

    if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate option ids are not allowed', path: ['options'] })
    }

    const texts = value.options.map((option) => option.text.toLowerCase())

    if (new Set(texts).size !== texts.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Options must be different from each other', path: ['options'] })
    }
})

export const reorderQuestionsSchema = z.object({ questionIds: uniqueIds('questionId') })

// A submitted attempt: only which option was chosen for which question.
export const quizAttemptSchema = z.object({
    answers: z.array(z.object({
        questionId: objectId('questionId'),
        optionId: objectId('optionId')
    })).min(1, 'Answer every question').max(200)
})

// ---- AI assistance (M9): user data only. There is deliberately no field for a system prompt,
// a provider or a model: the backend owns those. Unknown keys are stripped.
export const aiQuestionSchema = z.object({
    question: z.string().trim().min(3, 'Ask a question of at least 3 characters').max(500, 'The question is too long (500 characters at most)')
})

export const aiQuizDraftSchema = z.object({
    count: z.number().int().min(1).max(10).default(5),
    focus: z.string().trim().max(200, 'The focus is too long (200 characters at most)').optional()
})
