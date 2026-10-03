import { DATA_RULES } from './shared.js'

// Instructor: a DRAFT of final-quiz questions from the course text. JSON output. The draft is only a
// suggestion: nothing here is saved, and an accepted question goes through the normal quiz API.
export const quizDraftPrompt = ({ context, count, focus }) => {
    const lessons = context.sections
        .map((section) => {
            const body = section.lessons
                .map((lesson) =>
                    lesson.text
                        ? `### Lesson: ${lesson.title}\n${lesson.text}${lesson.truncated ? '\n[text shortened]' : ''}`
                        : `### Lesson: ${lesson.title}\n[${lesson.type === 'video' ? 'video lesson: no text available' : 'no text'}]`
                )
                .join('\n\n')

            return `## Section: ${section.title}\n${body}`
        })
        .join('\n\n')

    return {
        responseFormat: 'json',
        temperature: 0.5,
        systemPrompt: [
            'You help an instructor draft final-quiz questions for a course.',
            DATA_RULES,
            `Write exactly ${count} single-answer multiple-choice questions based only on the lesson text. Skip lessons that have no text.`,
            'Each question has 3 to 5 short options: exactly one correct and reasonable, plausible wrong options. Questions must be answerable from the lesson text and must not repeat each other.',
            'Reply with a single JSON object and nothing else:',
            '{"questions": [{"prompt": string, "options": [string, string, string], "correctIndex": integer}]}',
            'correctIndex is the zero-based position of the correct option in options.',
        ].join('\n'),
        userPrompt: [
            `Course: ${context.courseTitle}`,
            '<course_content>',
            lessons,
            '</course_content>',
            focus ? `<focus>${focus}</focus>` : null,
        ]
            .filter(Boolean)
            .join('\n'),
    }
}
