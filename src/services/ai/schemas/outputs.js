import { z } from 'zod'
import { quizQuestionSchema } from '../../../utils/schema.js'

// Provider output is untrusted text that is probably JSON. Nothing is used before it has been parsed
// and validated here, and nothing malformed is ever stored.

// Pulls a JSON object out of a model reply: plain JSON, JSON inside a code fence, or JSON with a
// sentence around it. Returns undefined when there is none.
export const extractJson = (text) => {
    const cleaned = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

    for (const candidate of [cleaned, cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1)]) {
        try {
            return JSON.parse(candidate)
        } catch {
            // try the next candidate
        }
    }

    return undefined
}

const text = (max) => z.string().trim().min(1).max(max)

export const askOutputSchema = z.object({
    answer: text(4000),
    groundedInLesson: z.boolean().default(false),
})

export const summaryOutputSchema = z.string().trim().min(20).max(4000)

const practiceQuestion = z
    .object({
        question: text(500),
        options: z.array(text(300)).min(2).max(5),
        correctIndex: z.number().int().min(0),
        explanation: text(800),
    })
    .refine((q) => q.correctIndex < q.options.length, { message: 'correctIndex out of range' })
    .refine((q) => new Set(q.options.map((o) => o.toLowerCase())).size === q.options.length, { message: 'duplicate options' })

export const practiceOutputSchema = z.object({ questions: z.array(z.unknown()).min(1).max(10) })
export const parsePracticeQuestion = (value) => practiceQuestion.safeParse(value)

const draftQuestion = z
    .object({
        prompt: text(1000),
        options: z.array(text(500)).min(2).max(8),
        correctIndex: z.number().int().min(0),
    })
    .refine((q) => q.correctIndex < q.options.length, { message: 'correctIndex out of range' })

export const quizDraftOutputSchema = z.object({ questions: z.array(z.unknown()).min(1).max(20) })

// A draft question becomes EXACTLY the shape of the M8 quiz API ({ prompt, options: [{ text, isCorrect }] })
// and is checked with the very schema that API uses, so an accepted draft can never be something the
// normal quiz validation would refuse.
export const toQuizQuestion = (value) => {
    const parsed = draftQuestion.safeParse(value)

    if (!parsed.success) return null

    const candidate = {
        prompt: parsed.data.prompt,
        options: parsed.data.options.map((option, index) => ({ text: option, isCorrect: index === parsed.data.correctIndex })),
    }
    const checked = quizQuestionSchema.safeParse(candidate)

    return checked.success ? checked.data : null
}
