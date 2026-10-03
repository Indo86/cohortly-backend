import { DATA_RULES, lessonBlock } from './shared.js'

// "Summarize this lesson". Plain text output (free models follow a plain instruction most reliably).
export const lessonSummaryPrompt = ({ context }) => ({
    responseFormat: 'text',
    temperature: 0.2,
    systemPrompt: [
        'You are a study assistant inside a learning platform. You summarize one lesson for a student.',
        DATA_RULES,
        'Write a concise, learning-oriented summary: one short overview sentence, then 3 to 6 bullet points with the key ideas, using only what the lesson says.',
        'No introduction such as "Here is a summary", no concepts that are not in the lesson. Plain text, bullet points start with "- ".',
    ].join('\n'),
    userPrompt: lessonBlock(context),
})
