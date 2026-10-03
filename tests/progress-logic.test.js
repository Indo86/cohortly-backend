import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { byOrder, orderLessons, summarizeProgress } from '../src/utils/progress.js'

const section = (id, order) => ({ _id: id, order })
const lesson = (id, sectionId, order) => ({ _id: id, section: sectionId, order })
const done = (...ids) => new Set(ids)

describe('ordering', () => {
    it('sorts by order and breaks ties by _id so the sequence is always deterministic', () => {
        const rows = [{ _id: 'c', order: 1 }, { _id: 'b', order: 1 }, { _id: 'a', order: 0 }]

        assert.deepEqual([...rows].sort(byOrder).map((r) => r._id), ['a', 'b', 'c'])
        assert.deepEqual([...rows].reverse().sort(byOrder).map((r) => r._id), ['a', 'b', 'c'])
    })

    it('flattens lessons by section order first, then lesson order', () => {
        const sections = [section('s2', 1), section('s1', 0)]
        const lessons = [lesson('l3', 's2', 0), lesson('l2', 's1', 1), lesson('l1', 's1', 0)]

        assert.deepEqual(orderLessons(sections, lessons).map((l) => l._id), ['l1', 'l2', 'l3'])
    })

    it('ignores lessons of unknown sections', () => {
        assert.deepEqual(orderLessons([section('s1', 0)], [lesson('x', 'gone', 0)]), [])
    })
})

describe('summarizeProgress', () => {
    const ordered = [lesson('l1', 's', 0), lesson('l2', 's', 1), lesson('l3', 's', 2)]

    it('zero lessons: 0 of 0, 0 percent, never completed, no next lesson', () => {
        const { progress, nextLesson } = summarizeProgress([], done())

        assert.deepEqual(progress, { completedLessons: 0, totalLessons: 0, percent: 0, completed: false })
        assert.equal(nextLesson, null)
    })

    it('nothing completed: 0 percent and the first lesson is next', () => {
        const { progress, nextLesson } = summarizeProgress(ordered, done())

        assert.equal(progress.percent, 0)
        assert.equal(progress.completed, false)
        assert.equal(nextLesson._id, 'l1')
    })

    it('rounds the percentage DOWN so 100 only ever means exactly complete', () => {
        assert.equal(summarizeProgress(ordered, done('l1')).progress.percent, 33)
        assert.equal(summarizeProgress(ordered, done('l1', 'l2')).progress.percent, 66)

        const big = Array.from({ length: 200 }, (_, i) => lesson(`l${i}`, 's', i))
        const almost = new Set(big.slice(0, 199).map((l) => l._id))

        assert.equal(summarizeProgress(big, almost).progress.percent, 99)
        assert.equal(summarizeProgress(big, almost).progress.completed, false)
    })

    it('exactly 100 percent and completed only when every lesson is done; no next lesson', () => {
        const { progress, nextLesson } = summarizeProgress(ordered, done('l1', 'l2', 'l3'))

        assert.deepEqual(progress, { completedLessons: 3, totalLessons: 3, percent: 100, completed: true })
        assert.equal(nextLesson, null)
    })

    it('next lesson is the first incomplete one in course order, skipping completed lessons', () => {
        assert.equal(summarizeProgress(ordered, done('l1')).nextLesson._id, 'l2')
        assert.equal(summarizeProgress(ordered, done('l2')).nextLesson._id, 'l1', 'a gap is not skipped')
        assert.equal(summarizeProgress(ordered, done('l1', 'l3')).nextLesson._id, 'l2')
    })

    it('only counts completions of lessons that still exist', () => {
        const { progress } = summarizeProgress(ordered, done('l1', 'deleted-lesson'))

        assert.equal(progress.completedLessons, 1)
        assert.equal(progress.totalLessons, 3)
    })
})
