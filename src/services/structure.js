import sectionModel from '../models/sectionModel.js'
import lessonModel from '../models/lessonModel.js'
import { badRequest } from '../utils/httpError.js'
import { byOrder } from '../utils/progress.js'
import { sanitizeRichText } from '../utils/sanitize.js'

// New sections/lessons are always appended: order = last order + 1.
// (Two concurrent creates can pick the same value; the _id tie-break keeps the
// sequence deterministic and a reorder normalizes it.)
export const nextOrder = async (model, filter) => {
    const last = await model.findOne(filter).sort({ order: -1 }).select('order').lean()

    return last ? last.order + 1 : 0
}

// Rewrites the positions of ALL children of one parent to 0..n-1 in the given order.
// `ids` must be exactly the current children (no missing, extra, foreign or duplicate
// ids), so the result can never contain ambiguous duplicate orders.
//
// MongoDB gives no multi-document atomicity on a standalone server, so this is one
// ordered bulkWrite. If the process dies half-way the order stays a valid total order
// (sorted by order, then _id) but may be partly old and partly new; repeating the
// reorder request repairs it.
export const reorderChildren = async (model, parentFilter, ids, label) => {
    const current = await model.find(parentFilter).select('_id').lean()
    const currentIds = new Set(current.map((doc) => String(doc._id)))
    const requested = ids.map(String)

    const exact =
        requested.length === currentIds.size && requested.every((id) => currentIds.has(id))

    if (!exact) {
        throw badRequest(`${label} must list every item of the parent exactly once`, {
            code: 'REORDER_MISMATCH',
        })
    }

    await model.bulkWrite(
        requested.map((id, position) => ({
            updateOne: { filter: { _id: id, ...parentFilter }, update: { $set: { order: position } } },
        })),
        { ordered: true }
    )
}

// Ordered sections with their ordered lessons for the instructor view.
// Lesson content is only included when asked for.
export const buildOutline = async (courseId, { withContent = false } = {}) => {
    const [sections, lessons] = await Promise.all([
        sectionModel.find({ course: courseId }).lean(),
        lessonModel
            .find({ course: courseId })
            .select(`title type order section ${withContent ? 'text youtubeId' : ''}`)
            .lean(),
    ])

    return sections.sort(byOrder).map((section) => ({
        _id: section._id,
        title: section.title,
        order: section.order,
        lessons: lessons
            .filter((lesson) => String(lesson.section) === String(section._id))
            .sort(byOrder)
            .map((lesson) => ({
                _id: lesson._id,
                title: lesson.title,
                type: lesson.type,
                order: lesson.order,
                ...(withContent
                    ? { text: sanitizeRichText(lesson.text), youtubeId: lesson.youtubeId }
                    : {}),
            })),
    }))
}

// The persisted fields of a lesson for a validated body: TEXT keeps sanitized text only,
// VIDEO keeps the YouTube id only; the unused one is cleared.
export const lessonFields = (body) => {
    const text = body.type === 'text' ? sanitizeRichText(body.text) : undefined

    // a text lesson whose content is nothing but unsafe markup would end up empty
    if (body.type === 'text' && text.trim().length === 0) {
        throw badRequest('Validation error', {
            errors: [{ path: 'text', message: 'Content Text is required' }],
        })
    }

    return {
        title: body.title,
        type: body.type,
        text,
        youtubeId: body.type === 'video' ? body.youtubeId : undefined,
    }
}
