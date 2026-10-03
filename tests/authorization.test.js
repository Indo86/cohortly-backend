import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    PNG, auth, complete, createCategory, createCourse, createInstructor, createLesson, createSection, createStudent,
    enroll, models, resetDb, startTestEnv, stopTestEnv,
} from './helpers.js'

let request
let category

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(async () => {
    await resetDb()
    category = await createCategory()
})

describe('role enforcement', () => {
    it('blocks a student from every instructor endpoint with 403', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)
        const course = await createCourse(instructor, category, { published: true })
        const section = await createSection(course)
        const lesson = await createLesson(course, { section })
        await enroll(course, student)
        const headers = auth(student)
        const body = { title: 'Some title', type: 'text', text: '<p>content</p>' }

        const calls = [
            () => request.get('/api/courses').set(headers),
            () => request.get(`/api/courses/${course._id}`).set(headers),
            () => request.post('/api/courses').set(headers),
            () => request.put(`/api/courses/${course._id}`).set(headers),
            () => request.put(`/api/courses/${course._id}/status`).set(headers).send({ status: 'draft' }),
            () => request.delete(`/api/courses/${course._id}`).set(headers),
            () => request.get(`/api/courses/${course._id}/sections`).set(headers),
            () => request.post(`/api/courses/${course._id}/sections`).set(headers).send({ title: 'A section' }),
            () => request.patch(`/api/courses/${course._id}/sections/reorder`).set(headers).send({ sectionIds: [section._id] }),
            () => request.put(`/api/sections/${section._id}`).set(headers).send({ title: 'Renamed' }),
            () => request.delete(`/api/sections/${section._id}`).set(headers),
            () => request.post(`/api/sections/${section._id}/lessons`).set(headers).send(body),
            () => request.patch(`/api/sections/${section._id}/lessons/reorder`).set(headers).send({ lessonIds: [lesson._id] }),
            () => request.get(`/api/lessons/${lesson._id}`).set(headers),
            () => request.put(`/api/lessons/${lesson._id}`).set(headers).send(body),
            () => request.delete(`/api/lessons/${lesson._id}`).set(headers),
            () => request.get(`/api/courses/${course._id}/progress`).set(headers),
            () => request.get(`/api/courses/students/${course._id}`).set(headers),
            () => request.post(`/api/courses/students/${course._id}`).set(headers).send({ studentId: student._id }),
            () => request.get('/api/students').set(headers),
            () => request.get(`/api/students/${student._id}`).set(headers),
            () => request.delete(`/api/students/${student._id}`).set(headers),
            () => request.get('/api/overviews').set(headers),
        ]

        for (const call of calls) {
            const res = await call()

            assert.equal(res.status, 403, `${res.request.method} ${res.request.url}`)
        }

        assert.ok(await models.courseModel.exists({ _id: course._id }), 'course must survive')
        assert.ok(await models.lessonModel.exists({ _id: lesson._id }), 'lesson must survive')
    })

    it('blocks an instructor from the student-only endpoints with 403', async () => {
        const instructor = await createInstructor()
        const course = await createCourse(instructor, category, { published: true })
        const lesson = await createLesson(course)
        const headers = auth(instructor)

        for (const [method, url] of [
            ['get', '/api/students-courses'],
            ['get', `/api/students-courses/${course._id}`],
            ['get', `/api/students-courses/${course._id}/lessons/${lesson._id}`],
            ['put', `/api/lessons/${lesson._id}/completion`],
            ['delete', `/api/lessons/${lesson._id}/completion`],
        ]) {
            assert.equal((await request[method](url).set(headers)).status, 403, `${method} ${url}`)
        }
    })

    it('requires authentication on every protected endpoint (401)', async () => {
        const urls = ['/api/courses', '/api/categories', '/api/students', '/api/students-courses', '/api/overviews']

        for (const url of urls) {
            assert.equal((await request.get(url)).status, 401, url)
        }
    })

    it('lets any authenticated user read categories', async () => {
        const instructor = await createInstructor({ active: false })

        const res = await request.get('/api/categories').set(auth(instructor))

        assert.equal(res.status, 200)
        assert.equal(res.body.data.length, 1)
    })
})

describe('instructor ownership isolation', () => {
    let a, b, courseA, sectionA, lessonA, studentA

    beforeEach(async () => {
        a = await createInstructor()
        b = await createInstructor()
        courseA = await createCourse(a, category, { published: true })
        sectionA = await createSection(courseA)
        lessonA = await createLesson(courseA, { section: sectionA })
        studentA = await createStudent(a)
        await enroll(courseA, studentA)
        await complete(studentA, lessonA)
    })

    it('lists only the caller own courses, students and overview', async () => {
        await createCourse(b, category)
        await createStudent(b)

        const courses = await request.get('/api/courses').set(auth(b))
        const students = await request.get('/api/students').set(auth(b))
        const overview = await request.get('/api/overviews').set(auth(b))

        assert.equal(courses.body.data.length, 1)
        assert.equal(students.body.data.length, 1)
        assert.equal(overview.body.data.totalCourses, 1)
        assert.equal(overview.body.data.totalStudents, 0)
        assert.equal(overview.body.data.students.length, 1)
        assert.equal(overview.body.data.totalTexts, 0)
    })

    it('cannot read, update, publish or delete another instructor course (404)', async () => {
        const headers = auth(b)

        const read = await request.get(`/api/courses/${courseA._id}`).set(headers)
        const update = await request
            .put(`/api/courses/${courseA._id}`)
            .set(headers)
            .field('name', 'Hijacked name')
            .field('tagline', 'Hijacked tagline')
            .field('description', 'Hijacked description')
            .field('categoryId', category._id.toString())
        const status = await request.put(`/api/courses/${courseA._id}/status`).set(headers).send({ status: 'draft' })
        const remove = await request.delete(`/api/courses/${courseA._id}`).set(headers)

        assert.deepEqual([read.status, update.status, status.status, remove.status], [404, 404, 404, 404])

        const stored = await models.courseModel.findById(courseA._id)
        assert.equal(stored.name, courseA.name)
        assert.equal(stored.status, 'published')
        assert.equal(String(stored.manager), String(a._id))
    })

    it('cannot list, create, rename, reorder or delete sections of another instructor', async () => {
        const headers = auth(b)

        const calls = [
            request.get(`/api/courses/${courseA._id}/sections`).set(headers),
            request.post(`/api/courses/${courseA._id}/sections`).set(headers).send({ title: 'Hijacked section' }),
            request.patch(`/api/courses/${courseA._id}/sections/reorder`).set(headers).send({ sectionIds: [sectionA._id] }),
            request.put(`/api/sections/${sectionA._id}`).set(headers).send({ title: 'Hijacked section' }),
            request.delete(`/api/sections/${sectionA._id}`).set(headers),
        ]

        for (const res of await Promise.all(calls)) assert.equal(res.status, 404)

        assert.equal(await models.sectionModel.countDocuments({ course: courseA._id }), 1)
        assert.equal((await models.sectionModel.findById(sectionA._id)).title, 'Section title')
    })

    it('cannot read, create, update, reorder or delete lessons of another instructor', async () => {
        const headers = auth(b)
        const body = { title: 'Hijacked lesson', type: 'text', text: '<p>hijacked</p>' }

        const calls = [
            request.get(`/api/lessons/${lessonA._id}`).set(headers),
            request.put(`/api/lessons/${lessonA._id}`).set(headers).send(body),
            request.delete(`/api/lessons/${lessonA._id}`).set(headers),
            request.post(`/api/sections/${sectionA._id}/lessons`).set(headers).send(body),
            request.patch(`/api/sections/${sectionA._id}/lessons/reorder`).set(headers).send({ lessonIds: [lessonA._id] }),
        ]

        for (const res of await Promise.all(calls)) assert.equal(res.status, 404)

        assert.equal((await models.lessonModel.findById(lessonA._id)).title, 'Lesson title')
        assert.equal(await models.lessonModel.countDocuments({ course: courseA._id }), 1)
        assert.equal(await models.lessonProgressModel.countDocuments(), 1, 'progress untouched')
    })

    it('cannot read the learner progress of another instructor course (404)', async () => {
        const res = await request.get(`/api/courses/${courseA._id}/progress`).set(auth(b))

        assert.equal(res.status, 404)
    })

    it('cannot read, update or delete another instructor student', async () => {
        const headers = auth(b)

        const read = await request.get(`/api/students/${studentA._id}`).set(headers)
        const update = await request
            .put(`/api/students/${studentA._id}`)
            .set(headers)
            .field('name', 'Hijacked student')
            .field('email', 'hijacked@test.dev')
        const remove = await request.delete(`/api/students/${studentA._id}`).set(headers)

        assert.deepEqual([read.status, update.status, remove.status], [404, 404, 404])
        assert.ok(await models.userModel.exists({ _id: studentA._id, email: studentA.email }))
        assert.equal(await models.lessonProgressModel.countDocuments(), 1)
    })

    it('cannot read or alter the enrollments of another instructor course', async () => {
        const headers = auth(b)
        const studentB = await createStudent(b)

        const list = await request.get(`/api/courses/students/${courseA._id}`).set(headers)
        const add = await request.post(`/api/courses/students/${courseA._id}`).set(headers).send({ studentId: studentB._id })
        const remove = await request.put(`/api/courses/students/${courseA._id}`).set(headers).send({ studentId: studentA._id })

        assert.deepEqual([list.status, add.status, remove.status], [404, 404, 404])
        assert.equal((await models.courseModel.findById(courseA._id)).students.length, 1)
        assert.equal(await models.lessonProgressModel.countDocuments(), 1, 'progress not deleted by a foreign unenroll')
    })

    it('cannot enroll a student that belongs to another instructor', async () => {
        const courseB = await createCourse(b, category)

        const res = await request
            .post(`/api/courses/students/${courseB._id}`)
            .set(auth(b))
            .send({ studentId: studentA._id })

        assert.equal(res.status, 404)
        assert.equal((await models.courseModel.findById(courseB._id)).students.length, 0)
    })

    it('cannot enroll an instructor account as a student', async () => {
        const res = await request
            .post(`/api/courses/students/${courseA._id}`)
            .set(auth(a))
            .send({ studentId: b._id })

        assert.equal(res.status, 404)
    })

    it('cannot attach a course to a category that does not exist', async () => {
        const res = await request
            .put(`/api/courses/${courseA._id}`)
            .set(auth(a))
            .field('name', 'Valid course name')
            .field('tagline', 'Valid tagline')
            .field('description', 'Valid description text')
            .field('categoryId', '64b64b64b64b64b64b64b64b')

        assert.equal(res.status, 400)
    })

    it('lets the owner do the same operations (happy path)', async () => {
        const headers = auth(a)

        assert.equal((await request.get(`/api/courses/${courseA._id}`).set(headers)).status, 200)
        assert.equal((await request.get(`/api/courses/${courseA._id}/sections`).set(headers)).status, 200)
        assert.equal((await request.get(`/api/lessons/${lessonA._id}`).set(headers)).status, 200)
        assert.equal((await request.get(`/api/courses/${courseA._id}/progress`).set(headers)).status, 200)
        assert.equal((await request.get(`/api/students/${studentA._id}`).set(headers)).status, 200)
        const list = await request.get(`/api/courses/students/${courseA._id}`).set(headers)
        assert.equal(list.status, 200)
        assert.equal(list.body.data.students.length, 1)
    })
})

describe('student access rules', () => {
    it('lets a student read only an enrolled, published course without roster or owner data', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)
        const course = await createCourse(instructor, category, { published: true })
        await createLesson(course)
        await enroll(course, student)

        const res = await request.get(`/api/students-courses/${course._id}`).set(auth(student))

        assert.equal(res.status, 200)
        assert.equal(res.body.data.sections[0].lessons.length, 1)
        assert.equal(res.body.data.students, undefined)
        assert.equal(res.body.data.manager, undefined)
        assert.equal(res.body.data.status, undefined)
    })

    it('hides a course the student is not enrolled in (404)', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)
        const course = await createCourse(instructor, category, { published: true })
        await createLesson(course)

        const res = await request.get(`/api/students-courses/${course._id}`).set(auth(student))

        assert.equal(res.status, 404)
    })

    it('hides another instructor course from a student of a different instructor', async () => {
        const a = await createInstructor()
        const b = await createInstructor()
        const studentB = await createStudent(b)
        const courseA = await createCourse(a, category, { published: true })
        await createLesson(courseA)
        await enroll(courseA, await createStudent(a))

        const res = await request.get(`/api/students-courses/${courseA._id}`).set(auth(studentB))

        assert.equal(res.status, 404)
    })

    it('lists only the published courses the student is enrolled in', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)
        const enrolled = await createCourse(instructor, category, { published: true })
        await createCourse(instructor, category, { published: true })
        await enroll(enrolled, student)

        const res = await request.get('/api/students-courses').set(auth(student))

        assert.equal(res.status, 200)
        assert.equal(res.body.data.length, 1)
        assert.equal(res.body.data[0]._id, enrolled._id.toString())
    })

    it('does not let students read the instructor lesson endpoint', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)
        const course = await createCourse(instructor, category, { published: true })
        const lesson = await createLesson(course)
        await enroll(course, student)

        const res = await request.get(`/api/lessons/${lesson._id}`).set(auth(student))

        assert.equal(res.status, 403)
    })
})

describe('instructor course lifecycle (regression)', () => {
    it('creates a draft course with a thumbnail, builds it, publishes it and deletes it, keeping relations consistent', async () => {
        const instructor = await createInstructor()
        const headers = auth(instructor)

        const created = await request
            .post('/api/courses')
            .set(headers)
            .field('name', 'Intro to testing')
            .field('tagline', 'Learn testing')
            .field('description', 'A long enough description')
            .field('categoryId', category._id.toString())
            .attach('thumbnail', PNG, { filename: 'cover.png', contentType: 'image/png' })

        assert.equal(created.status, 200)

        const [course] = (await request.get('/api/courses').set(headers)).body.data
        assert.equal(course.category.name, 'Programming')
        assert.equal(course.status, 'draft')
        assert.match(course.thumbnail_url, /^http:\/\/api\.test\/uploads\/courses\/thumbnail-.+\.png$/)

        const section = await request.post(`/api/courses/${course._id}/sections`).set(headers).send({ title: 'Basics' })
        const lesson = await request
            .post(`/api/sections/${section.body.data._id}/lessons`)
            .set(headers)
            .send({ title: 'Video lesson', type: 'video', youtubeId: 'dQw4w9WgXcQ' })
        assert.equal(lesson.status, 201)

        const detail = await request.get(`/api/courses/${course._id}?preview=true`).set(headers)
        assert.equal(detail.body.data.sections[0].lessons[0].youtubeId, 'dQw4w9WgXcQ')
        assert.equal(detail.body.data.total_lessons, 1)

        const overview = await request.get('/api/overviews').set(headers)
        assert.equal(overview.body.data.totalVideos, 1)
        assert.equal(overview.body.data.totalCourses, 1)
        assert.equal(overview.body.data.publishedCourses, 0)

        const del = await request.delete(`/api/courses/${course._id}`).set(headers)
        assert.equal(del.status, 200)
        assert.equal(await models.sectionModel.countDocuments(), 0)
        assert.equal(await models.lessonModel.countDocuments(), 0)
        assert.deepEqual((await models.userModel.findById(instructor._id)).courses, [])
    })

    it('enrolls and unenrolls a student and keeps both sides in sync', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)
        const course = await createCourse(instructor, category)
        const headers = auth(instructor)

        await request.post(`/api/courses/students/${course._id}`).set(headers).send({ studentId: student._id })
        await request.post(`/api/courses/students/${course._id}`).set(headers).send({ studentId: student._id })

        assert.equal((await models.courseModel.findById(course._id)).students.length, 1, 'no duplicate enrollment')
        assert.equal((await models.userModel.findById(student._id)).courses.length, 1)

        await request.put(`/api/courses/students/${course._id}`).set(headers).send({ studentId: student._id })

        assert.equal((await models.courseModel.findById(course._id)).students.length, 0)
        assert.equal((await models.userModel.findById(student._id)).courses.length, 0)
    })

    it('removes a deleted student from every course', async () => {
        const instructor = await createInstructor()
        const student = await createStudent(instructor)
        const c1 = await createCourse(instructor, category)
        const c2 = await createCourse(instructor, category)
        await enroll(c1, student)
        await enroll(c2, student)

        const res = await request.delete(`/api/students/${student._id}`).set(auth(instructor))

        assert.equal(res.status, 200)
        assert.equal((await models.courseModel.findById(c1._id)).students.length, 0)
        assert.equal((await models.courseModel.findById(c2._id)).students.length, 0)
    })
})
