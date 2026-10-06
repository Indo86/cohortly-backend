import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { publishBlockers } from '../src/services/publishing.js'

const id = () => new mongoose.Types.ObjectId()

// a plain-object quiz (no database) with `n` complete questions
const readyQuiz = (n = 1) => ({
    passingScore: 70,
    questions: Array.from({ length: n }, (_, order) => {
        const options = [{ _id: id(), text: 'Right' }, { _id: id(), text: 'Wrong' }]

        return { _id: id(), prompt: `Question ${order + 1}?`, order, options, correctOption: options[0]._id }
    }),
})

const codes = (facts) => publishBlockers(facts).map((blocker) => blocker.code)

describe('publishBlockers: the one publish-eligibility rule', () => {
    it('a course with a lesson and no quiz can be published', () => {
        assert.deepEqual(publishBlockers({ lessonCount: 1 }), [])
        assert.deepEqual(publishBlockers({ lessonCount: 12, quiz: null }), [])
    })

    it('a course without lessons cannot be published (COURSE_NOT_PUBLISHABLE)', () => {
        const [blocker] = publishBlockers({ lessonCount: 0 })

        assert.equal(blocker.code, 'COURSE_NOT_PUBLISHABLE')
        assert.equal(blocker.message, 'A course needs at least one lesson before it can be published')
        assert.deepEqual(codes({ lessonCount: -1 }), ['COURSE_NOT_PUBLISHABLE'])
    })

    it('a ready quiz does not block; an unfinished quiz does, with its problems (QUIZ_NOT_READY)', () => {
        assert.deepEqual(publishBlockers({ lessonCount: 1, quiz: readyQuiz(2) }), [])

        const [blocker] = publishBlockers({ lessonCount: 1, quiz: { passingScore: 70, questions: [] } })

        assert.equal(blocker.code, 'QUIZ_NOT_READY')
        assert.deepEqual(blocker.problems.map((problem) => problem.code), ['NO_QUESTIONS'])
    })

    it('reports the lesson rule first, like the publish endpoint always did', () => {
        assert.deepEqual(codes({ lessonCount: 0, quiz: { passingScore: 70, questions: [] } }), ['COURSE_NOT_PUBLISHABLE', 'QUIZ_NOT_READY'])
    })
})
