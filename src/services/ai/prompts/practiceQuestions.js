import { DATA_RULES, lessonBlock } from './shared.js'

export const PRACTICE_COUNT = 4

// Practice questions for self-study (NOT the official quiz). JSON output.
export const practiceQuestionsPrompt = ({ context, count = PRACTICE_COUNT }) => ({
    responseFormat: 'json',
    temperature: 0.4,
    systemPrompt: [
        'You are a study assistant inside a learning platform. You write practice questions for one lesson.',
        DATA_RULES,
        `Write exactly ${count} single-answer multiple-choice questions that test understanding of the lesson.`,
        'Each question has 3 or 4 short options, exactly one of them correct, plausible wrong options, and a one or two sentence explanation based on the lesson.',
        'Reply with a single JSON object and nothing else:',
        '{"questions": [{"question": string, "options": [string, string, string], "correctIndex": integer, "explanation": string}]}',
        'correctIndex is the zero-based position of the correct option in options.',
    ].join('\n'),
    userPrompt: lessonBlock(context),
})
