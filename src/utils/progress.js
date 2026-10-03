// Pure ordering and progress logic (no database).
//
// Order: sections ascending by `order`, lessons ascending by `order` within their
// section, ties always broken by _id, so the sequence is deterministic even if two
// rows ever share an order value.
//
// Progress is DERIVED from completion records, never stored:
//   totalLessons     all lessons currently in the course
//   completedLessons how many of those have a completion record
//   percent          integer 0-100, rounded DOWN, so 100 means exactly complete
//   completed        the COURSE is complete: see summarizeProgress (all lessons completed, and
//                    the final quiz passed when the course has one)
//   nextLesson       first lesson in order without a completion, or null
// Because nothing is cached, adding or deleting lessons or undoing a completion
// recalculates everything automatically.

export const byOrder = (a, b) =>
    (a.order ?? 0) - (b.order ?? 0) || String(a._id).localeCompare(String(b._id))

// Flattens lessons into course order: section order first, then lesson order.
export const orderLessons = (sections, lessons) => {
    const bySection = new Map()

    for (const lesson of lessons) {
        const key = String(lesson.section)

        if (!bySection.has(key)) bySection.set(key, [])
        bySection.get(key).push(lesson)
    }

    return [...sections]
        .sort(byOrder)
        .flatMap((section) => (bySection.get(String(section._id)) ?? []).sort(byOrder))
}

// `completedLessonIds` is a Set of lesson id strings.
//
// THE ONE COURSE-COMPLETION RULE (nothing else in the backend decides completion):
//   course without a final quiz:  completed = totalLessons > 0 && every lesson completed
//   course with a final quiz:     completed = totalLessons > 0 && every lesson completed && quiz passed
// `assessment` is { quizRequired, quizPassed }; omitted (a course with no quiz) it is exactly the
// old lessons-only behaviour. `percent` stays the LESSON percentage: a missing or failed quiz
// never turns it into 99.
export const summarizeProgress = (orderedLessons, completedLessonIds, assessment = {}) => {
    const { quizRequired = false, quizPassed = false } = assessment
    const totalLessons = orderedLessons.length
    const done = orderedLessons.filter((lesson) => completedLessonIds.has(String(lesson._id)))
    const completedLessons = done.length
    const allLessonsCompleted = totalLessons > 0 && completedLessons === totalLessons

    return {
        progress: {
            completedLessons,
            totalLessons,
            percent: totalLessons === 0 ? 0 : Math.floor((completedLessons * 100) / totalLessons),
            completed: allLessonsCompleted && (!quizRequired || quizPassed),
        },
        nextLesson:
            orderedLessons.find((lesson) => !completedLessonIds.has(String(lesson._id))) ?? null,
    }
}

export const allLessonsCompleted = (orderedLessons, completedLessonIds) =>
    orderedLessons.length > 0 && orderedLessons.every((lesson) => completedLessonIds.has(String(lesson._id)))
