import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    auth, createCategory, createCourse, createInstructor, createLesson, createSection, createStudent, enroll, models,
    resetDb, startTestEnv, stopTestEnv,
} from './helpers.js'

let request
let instructor
let course
let section

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(async () => {
    await resetDb()
    instructor = await createInstructor()
    course = await createCourse(instructor, await createCategory(), { published: true })
    section = await createSection(course)
})

const createText = (text) =>
    request
        .post(`/api/sections/${section._id}/lessons`)
        .set(auth(instructor))
        .send({ title: 'Lesson title', type: 'text', text })

const storedText = async () => (await models.lessonModel.findOne({ course: course._id })).text

describe('rich text sanitization (stored at write time)', () => {
    it('removes script tags', async () => {
        await createText('<p>Hi</p><script>alert(1)</script>')

        const text = await storedText()
        assert.equal(text.includes('script'), false)
        assert.equal(text.includes('alert'), false)
        assert.ok(text.includes('<p>Hi</p>'))
    })

    it('removes inline event handlers', async () => {
        await createText('<p onclick="steal()">x</p><a href="https://ok.test" onmouseover="steal()">l</a>')

        const text = await storedText()
        assert.equal(/onclick|onmouseover|steal/.test(text), false)
        assert.ok(text.includes('href="https://ok.test"'))
    })

    it('removes javascript: and data: URLs from links', async () => {
        await createText('<a href="javascript:alert(1)">a</a><a href="data:text/html;base64,AAAA">b</a>')

        const text = await storedText()
        assert.equal(/javascript:|data:/.test(text), false)
    })

    it('removes iframes, images with handlers, svg and style tags', async () => {
        await createText(
            '<iframe src="https://evil.test"></iframe><img src=x onerror="alert(1)"><svg onload="alert(1)"></svg><style>body{}</style><p>ok</p>'
        )

        const text = await storedText()
        assert.equal(/iframe|<img|onerror|<svg|onload|<style/.test(text), false)
        assert.ok(text.includes('<p>ok</p>'))
    })

    it('strips dangerous inline styles but keeps the indent margin', async () => {
        await createText('<p style="margin-left:40px;position:fixed;background:url(javascript:1)">x</p>')

        const text = await storedText()
        assert.ok(text.includes('margin-left:40px'))
        assert.equal(/position|javascript|background/.test(text), false)
    })

    it('preserves legitimate CKEditor content', async () => {
        const html =
            '<h2>Title</h2><p><strong>bold</strong> and <i>italic</i> with a <a href="https://docs.test/page">link</a></p>' +
            '<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>' +
            '<figure class="table"><table><tbody><tr><td>cell</td></tr></tbody></table></figure>' +
            '<figure class="media"><oembed url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"></oembed></figure>'

        await createText(html)

        const text = await storedText()
        for (const fragment of [
            '<h2>Title</h2>', '<strong>bold</strong>', '<i>italic</i>', 'href="https://docs.test/page"',
            '<ul><li>one</li><li>two</li></ul>', '<ol><li>first</li></ol>', '<figure class="table">',
            '<td>cell</td>', '<figure class="media">', 'oembed url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"',
        ]) {
            assert.ok(text.includes(fragment), `missing ${fragment}`)
        }
    })

    it('rejects a text lesson whose content is nothing but unsafe markup', async () => {
        const res = await createText('<script>alert(1)</script>')

        assert.equal(res.status, 400)
        assert.equal(await models.lessonModel.countDocuments({ course: course._id }), 0)
    })

    it('sanitizes on update as well', async () => {
        const lesson = await createLesson(course, { section })

        const res = await request
            .put(`/api/lessons/${lesson._id}`)
            .set(auth(instructor))
            .send({ title: 'Lesson title', type: 'text', text: '<p>new</p><script>x()</script>' })

        assert.equal(res.status, 200)
        assert.equal((await storedText()).includes('script'), false)
    })

    it('also cleans legacy unsanitized rows when they are read (instructor and student)', async () => {
        const legacy = await createLesson(course, { section, text: '<p>old</p><img src=x onerror="alert(1)">' })
        const student = await createStudent(instructor)
        await enroll(course, student)

        const asInstructor = await request.get(`/api/lessons/${legacy._id}`).set(auth(instructor))
        const asStudent = await request
            .get(`/api/students-courses/${course._id}/lessons/${legacy._id}`)
            .set(auth(student))
        const outline = await request.get(`/api/courses/${course._id}?preview=true`).set(auth(instructor))

        assert.equal(asInstructor.body.data.text.includes('onerror'), false)
        assert.equal(asStudent.body.data.text.includes('onerror'), false)
        assert.equal(JSON.stringify(outline.body).includes('onerror'), false)
    })
})
