import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    auth, createCategory, createCourse, createInstructor, createLesson, createStudent, enroll, models, resetDb, startTestEnv, stopTestEnv,
} from './helpers.js'

// Instructor dashboard "Students" (GET /api/overviews totalStudents) = the number of UNIQUE students
// enrolled in at least one of the signed-in instructor's courses.
let request
let instructor
let category

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(async () => {
    await resetDb()
    instructor = await createInstructor()
    category = await createCategory()
})

const overview = async (who = instructor) => {
    const res = await request.get('/api/overviews').set(auth(who))

    assert.equal(res.status, 200)

    return res.body.data
}

describe('instructor dashboard: totalStudents counts unique enrolled students', () => {
    it('one student with one enrollment is 1', async () => {
        const course = await createCourse(instructor, category, { published: true })

        await enroll(course, await createStudent(instructor))

        assert.equal((await overview()).totalStudents, 1)
    })

    it('one student enrolled in two courses of the same instructor is still 1 (no double count)', async () => {
        const [first, second] = [await createCourse(instructor, category, { published: true }), await createCourse(instructor, category)]
        const student = await createStudent(instructor)

        await enroll(first, student)
        await enroll(second, student)

        const data = await overview()

        assert.equal(data.totalStudents, 1)
        // the per-course numbers keep counting enrollments, as before
        assert.deepEqual(data.courses.map((course) => course.total_students), [1, 1])
    })

    it('two students over several enrollments are 2 (the documented scenario: X in courses 1 and 2, Y in course 1)', async () => {
        const [course1, course2] = [await createCourse(instructor, category, { published: true }), await createCourse(instructor, category, { published: true })]
        const [x, y] = [await createStudent(instructor), await createStudent(instructor)]

        await enroll(course1, x)
        await enroll(course2, x)
        await enroll(course1, y)

        assert.equal((await overview()).totalStudents, 2)
    })

    it('students without any enrollment are listed but not counted', async () => {
        const course = await createCourse(instructor, category)

        await enroll(course, await createStudent(instructor))
        await createStudent(instructor)

        const data = await overview()

        assert.equal(data.totalStudents, 1)
        assert.equal(data.students.length, 2)
    })

    it('enrollments in another instructor\'s courses are never counted', async () => {
        const other = await createInstructor()
        const mine = await createCourse(instructor, category)
        const theirs = await createCourse(other, category)
        const [mineStudent, theirStudents] = [await createStudent(instructor), [await createStudent(other), await createStudent(other)]]

        await enroll(mine, mineStudent)
        for (const student of theirStudents) await enroll(theirs, student)

        assert.equal((await overview()).totalStudents, 1)
        assert.equal((await overview(other)).totalStudents, 2)
    })

    it('is 0 without courses or enrollments, and a deleted student stops counting', async () => {
        assert.equal((await overview()).totalStudents, 0)

        const course = await createCourse(instructor, category)
        const student = await createStudent(instructor)

        await createLesson(course)
        await enroll(course, student)
        assert.equal((await overview()).totalStudents, 1)

        assert.equal((await request.delete(`/api/students/${student._id}`).set(auth(instructor))).status, 200)
        assert.equal((await overview()).totalStudents, 0)
        assert.equal(await models.userModel.countDocuments({ _id: student._id }), 0)
    })
})
