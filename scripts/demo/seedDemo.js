import bcrypt from 'bcrypt'

import categoryModel from '../../src/models/categoryModel.js'
import certificateModel from '../../src/models/certificateModel.js'
import courseModel from '../../src/models/courseModel.js'
import lessonModel from '../../src/models/lessonModel.js'
import lessonProgressModel from '../../src/models/lessonProgressModel.js'
import quizAttemptModel from '../../src/models/quizAttemptModel.js'
import quizModel from '../../src/models/quizModel.js'
import sectionModel from '../../src/models/sectionModel.js'
import transactionModel from '../../src/models/transactionModel.js'
import userModel from '../../src/models/userModel.js'
import { deleteCourseCascade, deleteStudentCascade } from '../../src/services/cascade.js'
import { issueCertificateIfEligible } from '../../src/services/certificates.js'
import { getInstructorEntitlement } from '../../src/services/entitlement.js'
import { loadStudentStates } from '../../src/services/learning.js'
import { publishBlockers } from '../../src/services/publishing.js'
import { lessonFields } from '../../src/services/structure.js'
import { ACCESS } from '../../src/utils/accessStatus.js'
import { removeUpload } from '../../src/utils/files.js'
import { isQuizReady, scoreAttempt } from '../../src/utils/quiz.js'
import { ROLES } from '../../src/utils/roles.js'
import { lessonSchema, mutateCourseSchema, passwordSchema, quizSettingsSchema, sectionSchema } from '../../src/utils/schema.js'
import { COURSES, DEMO_CATEGORIES, DEMO_EMAILS, DEMO_PASSWORD, ENROLLMENTS, EXPECTED_STATES, INSTRUCTOR, STUDENTS } from './content.js'

// The demo workspace (npm run seed:demo), built through the application's own rules:
//   - passwords are bcrypt hashes made like the API makes them (and must satisfy the password policy);
//   - course, section, lesson and quiz bodies are validated with the API's schemas, lesson text goes
//     through the same sanitizer (lessonFields), publishing checks the same publish rule;
//   - the workspace is ACTIVE through a real successful payment record (no entitlement bypass);
//   - progress exists only as lesson completion records and quiz attempts scored by scoreAttempt;
//   - certificates are issued by the certificate service, exactly as after a real completion.
//
// IDEMPOTENT by "reset then rebuild": everything that belongs to the demo workspace (the demo
// instructor found by e-mail, the students it owns or that carry a demo e-mail, its courses with all
// their content, progress, attempts and certificates, and its payments) is removed with the
// application's cascades, then rebuilt. Nothing else is touched: other users, their courses and
// certificates stay as they are, and categories are only ever added (by name).
const DAY = 24 * 60 * 60 * 1000

const at = (now, daysAgo) => new Date(now.getTime() - daysAgo * DAY)

// ---- reset -------------------------------------------------------------------------------------

export const resetDemoData = async () => {
    const instructor = await userModel.findOne({ email: INSTRUCTOR.email, role: ROLES.INSTRUCTOR })
    const studentFilter = instructor
        ? { role: ROLES.STUDENT, $or: [{ email: { $in: DEMO_EMAILS } }, { manager: instructor._id }] }
        : { role: ROLES.STUDENT, email: { $in: DEMO_EMAILS } }
    const students = await userModel.find(studentFilter)
    const courses = instructor ? await courseModel.find({ manager: instructor._id }) : []

    const studentIds = students.map((student) => student._id)
    const courseIds = courses.map((course) => course._id)

    // certificates are kept by every application cascade on purpose, so the demo ones go first, explicitly
    const certificates = await certificateModel.deleteMany({ $or: [{ student: { $in: studentIds } }, { course: { $in: courseIds } }] })

    for (const course of courses) {
        await deleteCourseCascade(course)
        removeUpload('courses', course.thumbnail)
    }

    for (const student of students) {
        await deleteStudentCascade(student)
        removeUpload('students', student.photo)
    }

    if (instructor) {
        await transactionModel.deleteMany({ user: instructor._id })
        await userModel.deleteOne({ _id: instructor._id })
    }

    return {
        instructors: instructor ? 1 : 0,
        students: students.length,
        courses: courses.length,
        certificates: certificates.deletedCount,
    }
}

// ---- build -------------------------------------------------------------------------------------

const ensureCategories = async () => {
    const byName = new Map()

    for (const name of DEMO_CATEGORIES) {
        await categoryModel.updateOne({ name }, { $setOnInsert: { name } }, { upsert: true })
        byName.set(name, await categoryModel.findOne({ name }).sort({ _id: 1 }))
    }

    return byName
}

const createAccount = async (person, { role, manager, passwordHash }) =>
    userModel.create({
        name: person.name,
        email: person.email,
        password: passwordHash,
        photo: 'default.png',
        role,
        ...(manager ? { manager: manager._id } : {}),
    })

const buildCourse = async (definition, { instructor, category }) => {
    const details = mutateCourseSchema.parse({
        name: definition.name,
        tagline: definition.tagline,
        description: definition.description,
        categoryId: category._id.toString(),
    })

    const course = await courseModel.create({
        name: details.name,
        tagline: details.tagline,
        description: details.description,
        category: category._id,
        manager: instructor._id,
        thumbnail: '', // the frontend draws a cover from the course itself
        status: 'draft', // published below, through the publish rule
    })

    await categoryModel.updateOne({ _id: category._id }, { $addToSet: { courses: course._id } })
    await userModel.updateOne({ _id: instructor._id }, { $addToSet: { courses: course._id } })

    const lessons = new Map()

    for (const [sectionOrder, sectionDefinition] of definition.sections.entries()) {
        const section = await sectionModel.create({
            course: course._id,
            title: sectionSchema.parse({ title: sectionDefinition.title }).title,
            order: sectionOrder,
        })

        for (const [lessonOrder, lessonDefinition] of sectionDefinition.lessons.entries()) {
            const body = lessonSchema.parse(
                lessonDefinition.youtubeId
                    ? { title: lessonDefinition.title, type: 'video', youtubeId: lessonDefinition.youtubeId }
                    : { title: lessonDefinition.title, type: 'text', text: lessonDefinition.text }
            )
            const lesson = await lessonModel.create({ ...lessonFields(body), course: course._id, section: section._id, order: lessonOrder })

            lessons.set(lessonDefinition.key, lesson)
        }
    }

    let quiz = null

    if (definition.quiz) {
        const settings = quizSettingsSchema.parse({ title: definition.quiz.title, passingScore: definition.quiz.passingScore })

        quiz = new quizModel({ course: course._id, ...settings, questions: [] })

        for (const [order, question] of definition.quiz.questions.entries()) {
            quiz.questions.push({ prompt: question.prompt, order, options: question.options.map((option) => ({ text: option })) })

            const stored = quiz.questions.at(-1)

            stored.correctOption = stored.options[question.correct]._id
        }

        if (!isQuizReady(quiz)) throw new Error(`Demo quiz of "${definition.name}" is not ready`)

        await quiz.save()
    }

    if (definition.status === 'published') {
        const [blocker] = publishBlockers({ lessonCount: lessons.size, quiz })

        if (blocker) throw new Error(`Demo course "${definition.name}" cannot be published: ${blocker.code}`)

        course.status = 'published'
        await course.save()
    }

    return { course, lessons, quiz, definition }
}

const enroll = async (course, student) => {
    await courseModel.updateOne({ _id: course._id }, { $addToSet: { students: student._id } })
    await userModel.updateOne({ _id: student._id }, { $addToSet: { courses: course._id } })
}

// Answers for a whole quiz: per question, the correct option or the first wrong one.
const answersFor = (quiz, correctness) =>
    [...quiz.questions]
        .sort((a, b) => a.order - b.order)
        .map((question, index) => ({
            questionId: String(question._id),
            optionId: String(
                correctness[index]
                    ? question.correctOption
                    : question.options.find((option) => String(option._id) !== String(question.correctOption))._id
            ),
        }))

export const seedDemo = async ({ now = new Date(), password = DEMO_PASSWORD, bcryptRounds = 12 } = {}) => {
    passwordSchema.parse(password)

    const removed = await resetDemoData()
    const categories = await ensureCategories()
    const passwordHash = await bcrypt.hash(password, bcryptRounds)

    // instructor + an ACTIVE workspace through a real successful payment (no Midtrans call)
    const instructor = await createAccount(INSTRUCTOR, { role: ROLES.INSTRUCTOR, passwordHash })

    await transactionModel.create({
        user: instructor._id,
        price: 0,
        status: 'success',
        purpose: 'activation',
        periodMonths: 1,
        paidAt: at(now, 3),
        providerStatus: 'demo-seed',
        createdAt: at(now, 3),
    })

    const entitlement = await getInstructorEntitlement(instructor._id, now)

    if (entitlement.accessStatus !== ACCESS.ACTIVE) throw new Error('The demo workspace is not ACTIVE')

    const students = new Map()

    for (const person of STUDENTS) {
        students.set(person.key, await createAccount(person, { role: ROLES.STUDENT, manager: instructor, passwordHash }))
    }

    const courses = new Map()

    for (const definition of COURSES) {
        courses.set(definition.key, await buildCourse(definition, { instructor, category: categories.get(definition.category) }))
    }

    // enrollments, lesson completions and quiz attempts
    for (const plan of ENROLLMENTS) {
        const { course, lessons, quiz } = courses.get(plan.course)
        const student = students.get(plan.student)
        let lastActivity = null

        await enroll(course, student)

        for (const { lesson: key, daysAgo } of plan.completed) {
            const completedAt = at(now, daysAgo)

            await lessonProgressModel.create({ student: student._id, course: course._id, lesson: lessons.get(key)._id, completedAt })
            lastActivity = !lastActivity || completedAt > lastActivity ? completedAt : lastActivity
        }

        for (const attempt of plan.quizAttempts ?? []) {
            const submittedAt = at(now, attempt.daysAgo)
            const result = scoreAttempt(quiz, answersFor(quiz, attempt.correct))

            await quizAttemptModel.create({
                quiz: quiz._id,
                course: course._id,
                student: student._id,
                answers: result.answers,
                totalQuestions: result.totalQuestions,
                correctAnswers: result.correctAnswers,
                score: result.score,
                passingScore: quiz.passingScore,
                passed: result.passed,
                submittedAt,
            })

            if (result.passed && submittedAt > lastActivity) lastActivity = submittedAt
        }

        // the certificate service decides (published + enrolled + complete); dated when the last requirement was met
        await issueCertificateIfEligible(course._id, student._id, { issuedAt: lastActivity ?? now })
    }

    return { removed, ...(await describeDemo({ now })) }
}

// ---- report / self-check -----------------------------------------------------------------------

// What the demo workspace contains right now, read back from the database (used for the summary,
// the self-check below and the tests).
export const describeDemo = async ({ now = new Date() } = {}) => {
    const instructor = await userModel.findOne({ email: INSTRUCTOR.email, role: ROLES.INSTRUCTOR })

    if (!instructor) return { exists: false }

    const students = await userModel.find({ role: ROLES.STUDENT, manager: instructor._id }).sort({ email: 1 })
    const courses = await courseModel.find({ manager: instructor._id }).sort({ name: 1 })
    const courseIds = courses.map((course) => course._id)
    const certificates = await certificateModel.find({ course: { $in: courseIds } }).sort({ courseName: 1 }).lean()

    const states = []

    for (const definition of EXPECTED_STATES) {
        const course = courses.find((item) => item.name === COURSES.find((c) => c.key === definition.course).name)
        const student = students.find((item) => item.email === STUDENTS.find((s) => s.key === definition.student).email)

        if (!course || !student) continue

        const { state } = (await loadStudentStates([course._id], student._id)).get(String(course._id))

        states.push({
            course: definition.course,
            student: definition.student,
            completedLessons: state.progress.completedLessons,
            totalLessons: state.progress.totalLessons,
            percent: state.progress.percent,
            completed: state.progress.completed,
            certificate: Boolean(state.certificate),
        })
    }

    const count = (model, filter) => model.countDocuments(filter)

    return {
        exists: true,
        instructor: { email: instructor.email, accessStatus: (await getInstructorEntitlement(instructor._id, now)).accessStatus },
        students: students.map((student) => student.email),
        courses: courses.map((course) => ({ name: course.name, status: course.status, enrolled: course.students.length })),
        counts: {
            instructors: 1,
            students: students.length,
            courses: courses.length,
            published: courses.filter((course) => course.status === 'published').length,
            drafts: courses.filter((course) => course.status === 'draft').length,
            sections: await count(sectionModel, { course: { $in: courseIds } }),
            lessons: await count(lessonModel, { course: { $in: courseIds } }),
            quizzes: await count(quizModel, { course: { $in: courseIds } }),
            enrollments: courses.reduce((sum, course) => sum + course.students.length, 0),
            completions: await count(lessonProgressModel, { course: { $in: courseIds } }),
            quizAttempts: await count(quizAttemptModel, { course: { $in: courseIds } }),
            certificates: certificates.length,
            payments: await count(transactionModel, { user: instructor._id }),
        },
        certificates: certificates.map((certificate) => ({
            number: certificate.certificateNumber,
            student: certificate.studentName,
            course: certificate.courseName,
        })),
        states,
    }
}

// Compares the demo workspace with EXPECTED_STATES; returns the list of differences (empty = as designed).
export const demoProblems = (description) => {
    if (!description.exists) return ['the demo instructor does not exist']

    const problems = []

    if (description.instructor.accessStatus !== ACCESS.ACTIVE) problems.push(`workspace is ${description.instructor.accessStatus}`)

    for (const expected of EXPECTED_STATES) {
        const actual = description.states.find((state) => state.course === expected.course && state.student === expected.student)

        if (!actual) {
            problems.push(`${expected.student} is not enrolled in ${expected.course}`)
            continue
        }

        for (const field of ['completedLessons', 'completed', 'certificate']) {
            if (actual[field] !== expected[field]) problems.push(`${expected.student} / ${expected.course}: ${field} is ${actual[field]}, expected ${expected[field]}`)
        }
    }

    return problems
}
