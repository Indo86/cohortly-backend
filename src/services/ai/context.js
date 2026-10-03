import { aiError } from './errors.js'

// Turns stored content into the plain text an AI provider receives, with explicit size limits.
//
// SIZE STRATEGY (documented in the README): a lesson is truncated at MAX_LESSON_CHARS on a paragraph
// boundary and the model is told the text was cut; a course context is shared between its text
// lessons (each gets an equal budget of MAX_COURSE_CHARS, at least MIN_LESSON_BUDGET). Content over
// HARD_CEILING_CHARS is refused with AI_CONTEXT_TOO_LARGE instead of being silently processed.
export const MAX_QUESTION_CHARS = 500
export const MAX_FOCUS_CHARS = 200
export const MAX_LESSON_CHARS = 12000
export const MAX_COURSE_CHARS = 24000
export const MIN_LESSON_BUDGET = 800
export const HARD_CEILING_CHARS = 400000
export const MIN_LESSON_TEXT_CHARS = 40
export const MIN_COURSE_TEXT_CHARS = 200

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

// Lesson HTML is already sanitized by the backend (utils/sanitize.js: headings, lists, tables, links,
// quotes). This keeps what is meaningful (headings, list items, table cells) and drops the markup.
export const htmlToText = (html) =>
    String(html ?? '')
        .replace(/<oembed[^>]*>(<\/oembed>)?/gi, '')
        .replace(/<(h[1-6])[^>]*>/gi, '\n\n## ')
        .replace(/<\/h[1-6]>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<\/(p|div|blockquote|tr|ul|ol|figure|table)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/t[dh]>/gi, ' | ')
        .replace(/<[^>]+>/g, '')
        .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (match) => ENTITIES[match])
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

// The prompts wrap data in tags such as <lesson_content>. Content must not be able to close or
// reopen those tags and escape the data boundary, so any such tag inside the data is removed.
const BOUNDARY_TAGS = /<\/?\s*(lesson_content|course_content|student_question|focus|rules)\s*>/gi

export const neutralize = (text) => String(text ?? '').replace(BOUNDARY_TAGS, '')

export const truncate = (text, max) => {
    if (text.length <= max) return { text, truncated: false }

    const cut = text.slice(0, max)
    const boundary = cut.lastIndexOf('\n\n')
    const at = boundary > max * 0.6 ? boundary : cut.lastIndexOf(' ')

    return { text: cut.slice(0, at > 0 ? at : max).trim(), truncated: true }
}

const clean = (value, max) => neutralize(String(value ?? '')).replace(/\s+/g, ' ').trim().slice(0, max)

// ONE lesson, for the student tools. Only names and text: no ids, no student, no quiz data.
export const buildLessonContext = ({ course, section, lesson }) => {
    const text = lesson.type === 'text' ? htmlToText(lesson.text) : ''

    if (text.length > HARD_CEILING_CHARS) throw aiError('AI_CONTEXT_TOO_LARGE')

    // A video lesson only has a YouTube id: there is no transcript, so there is nothing to ground an answer in.
    if (text.length < MIN_LESSON_TEXT_CHARS) {
        throw aiError('AI_NO_TEXT_CONTEXT', 'This lesson has no text for AI study tools to use.')
    }

    const limited = truncate(neutralize(text), MAX_LESSON_CHARS)

    return {
        courseTitle: clean(course.name, 200),
        sectionTitle: clean(section?.title, 200),
        lessonTitle: clean(lesson.title, 200),
        text: limited.text,
        truncated: limited.truncated,
    }
}

// A whole OWNED course, for the instructor quiz draft: section and lesson titles plus the text of text lessons.
export const buildCourseContext = ({ course, sections, lessons }) => {
    const ordered = sections.map((section) => ({
        title: clean(section.title, 200),
        lessons: lessons.filter((lesson) => String(lesson.section) === String(section._id)),
    }))
    const textual = lessons.filter((lesson) => lesson.type === 'text')
    const raw = textual.map((lesson) => htmlToText(lesson.text))

    if (raw.reduce((sum, text) => sum + text.length, 0) > HARD_CEILING_CHARS) throw aiError('AI_CONTEXT_TOO_LARGE')

    const budget = Math.max(MIN_LESSON_BUDGET, Math.floor(MAX_COURSE_CHARS / Math.max(textual.length, 1)))
    const texts = new Map(textual.map((lesson, index) => [String(lesson._id), truncate(neutralize(raw[index]), budget)]))
    const usable = [...texts.values()].reduce((sum, item) => sum + item.text.length, 0)

    if (usable < MIN_COURSE_TEXT_CHARS) {
        throw aiError('AI_NO_TEXT_CONTEXT', 'This course does not have enough lesson text to base a quiz on. Video-only lessons cannot be used.')
    }

    return {
        courseTitle: clean(course.name, 200),
        sections: ordered.map((section) => ({
            title: section.title,
            lessons: section.lessons.map((lesson) => ({
                title: clean(lesson.title, 200),
                type: lesson.type,
                text: texts.get(String(lesson._id))?.text ?? '',
                truncated: texts.get(String(lesson._id))?.truncated ?? false,
            })),
        })),
    }
}

export const clientText = (value, max) => clean(value, max)
