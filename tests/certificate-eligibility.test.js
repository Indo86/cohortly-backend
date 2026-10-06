import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    auth, complete, createCategory, createCourse, createInstructor, createLesson, createSection, createStudent, enroll, models, resetDb,
    startTestEnv, stopTestEnv,
} from './helpers.js'
import { issueCertificateIfEligible } from '../src/services/certificates.js'

// Issuance rule (services/certificates.js): a NEW certificate needs a PUBLISHED course, an ENROLLED
// student and a COMPLETE course (one completion rule). Issued certificates are history: never revoked.
let request
let instructor
let student
let course
let lessons
let instructorHeaders

before(async () => {
    request = await startTestEnv()
})
after(stopTestEnv)
beforeEach(async () => {
    await resetDb()
    instructor = await createInstructor()
    instructorHeaders = auth(instructor)
    student = await createStudent(instructor)
    course = await createCourse(instructor, await createCategory(), { published: true })

    const section = await createSection(course)

    lessons = [await createLesson(course, { section, title: 'Lesson one' }), await createLesson(course, { section, title: 'Lesson two' })]
    await enroll(course, student)
})

const certificates = () => models.certificateModel.find({}).lean()
const setStatus = (status) => request.put(`/api/courses/${course._id}/status`).set(instructorHeaders).send({ status })
const completeLesson = (lesson) => request.put(`/api/lessons/${lesson._id}/completion`).set(auth(student))
const completeAllDirectly = async () => {
    for (const lesson of lessons) await complete(student, lesson)
}

describe('issuance needs a published course', () => {
    it('published + complete: the certificate is issued (through the learning API)', async () => {
        await completeLesson(lessons[0])

        const res = await completeLesson(lessons[1])

        assert.equal(res.status, 200)
        assert.equal(res.body.data.certificateIssued, true)
        assert.equal((await certificates()).length, 1)
    })

    it('draft + complete: nothing is issued (service level)', async () => {
        await completeAllDirectly()
        await models.courseModel.updateOne({ _id: course._id }, { status: 'draft' })

        const result = await issueCertificateIfEligible(course._id, student._id)

        assert.deepEqual(result, { certificate: null, issued: false, eligible: false })
        assert.equal((await certificates()).length, 0)
    })

    it('a draft course completed by deleting the missing lesson issues nothing; publishing it issues the certificate once', async () => {
        assert.equal((await completeLesson(lessons[0])).status, 200)
        assert.equal((await setStatus('draft')).status, 200)

        // the remaining lesson goes while the course is a draft: the student is now complete by the rule
        assert.equal((await request.delete(`/api/lessons/${lessons[1]._id}`).set(instructorHeaders)).status, 200)
        assert.equal((await certificates()).length, 0, 'a draft never issues a certificate')

        assert.equal((await setStatus('published')).status, 200)

        const issued = await certificates()

        assert.equal(issued.length, 1)
        assert.equal(String(issued[0].student), String(student._id))

        // publishing again (a no-op transition) or re-running the issuer creates nothing new
        assert.equal((await setStatus('published')).status, 200)
        await issueCertificateIfEligible(course._id, student._id)
        assert.equal((await certificates()).length, 1)
        assert.equal((await request.get(`/api/certificates/verify/${issued[0].certificateNumber}`)).status, 200)
    })
})

describe('issuance needs enrollment and completion', () => {
    it('incomplete: nothing is issued', async () => {
        await complete(student, lessons[0])

        assert.deepEqual(await issueCertificateIfEligible(course._id, student._id), { certificate: null, issued: false, eligible: false })
        assert.equal((await certificates()).length, 0)
    })

    it('not enrolled (completion records left over): nothing is issued', async () => {
        const outsider = await createStudent(instructor)

        for (const lesson of lessons) await complete(outsider, lesson)

        assert.equal((await issueCertificateIfEligible(course._id, outsider._id)).eligible, false)
        assert.equal((await certificates()).length, 0)
    })

    it('duplicate and concurrent issuance still create exactly one certificate', async () => {
        await completeAllDirectly()

        const results = await Promise.all(Array.from({ length: 8 }, () => issueCertificateIfEligible(course._id, student._id)))

        assert.equal(results.filter((result) => result.issued).length, 1)
        assert.equal((await certificates()).length, 1)
        assert.equal(new Set(results.map((result) => result.certificate.certificateNumber)).size, 1)
    })
})

describe('issued certificates are history', () => {
    it('unpublishing the course keeps an issued certificate valid, verifiable and visible to its student', async () => {
        await completeLesson(lessons[0])
        await completeLesson(lessons[1])

        const [issued] = await certificates()

        assert.equal((await setStatus('draft')).status, 200)

        const verification = await request.get(`/api/certificates/verify/${issued.certificateNumber}`)

        assert.equal(verification.status, 200)
        assert.equal(verification.body.data.valid, true)
        assert.equal((await request.get('/api/my-certificates').set(auth(student))).body.data.length, 1)

        // the existing certificate is returned as is: nothing new, nothing revoked
        const again = await issueCertificateIfEligible(course._id, student._id)

        assert.equal(again.issued, false)
        assert.equal(again.certificate.certificateNumber, issued.certificateNumber)
        assert.equal((await certificates()).length, 1)
    })
})
