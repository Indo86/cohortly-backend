// Idempotent bootstrap for a database.
//   npm run seed        -> categories only (safe for any environment)
//   npm run seed:demo   -> categories + the Cohortly demo workspace (scripts/demo/), reset to the same
//                          state on every run. Refused on production-looking targets (scripts/demo/guard.js).
// Never runs by itself (the server does not seed at start-up).
import 'dotenv/config'
import mongoose from 'mongoose'

import categoryModel from '../src/models/categoryModel.js'
import { ensureUploadDirs } from '../src/config/paths.js'
import { DEMO_CATEGORIES, DEMO_PASSWORD, INSTRUCTOR, STUDENTS } from './demo/content.js'
import { demoTargetProblem } from './demo/guard.js'
import { demoProblems, seedDemo } from './demo/seedDemo.js'

const CATEGORIES = [
    'Programming',
    'Data Science',
    'Design',
    'Business',
    'Marketing',
    'Languages',
    'Leadership',
    'Cyber Security',
    ...DEMO_CATEGORIES,
]

const withDemo = process.argv.includes('--demo')

const fail = (message) => {
    console.error(message)
    process.exit(1)
}

if (!process.env.DATABASE_URL) fail('DATABASE_URL is required')

if (withDemo) {
    const problem = demoTargetProblem(process.env.DATABASE_URL)

    if (problem) fail(`Refusing to seed the demo workspace: ${problem}.`)
}

try {
    await mongoose.connect(process.env.DATABASE_URL)

    ensureUploadDirs()

    for (const name of CATEGORIES) {
        await categoryModel.updateOne({ name }, { $setOnInsert: { name } }, { upsert: true })
    }

    console.log(`Categories ensured: ${CATEGORIES.length}`)

    if (withDemo) {
        const password = process.env.DEMO_PASSWORD || DEMO_PASSWORD
        const result = await seedDemo({ password })
        const problems = demoProblems(result)

        if (problems.length > 0) throw new Error(`The demo workspace is not as designed:\n - ${problems.join('\n - ')}`)

        const { counts } = result
        const removed = result.removed.instructors + result.removed.students + result.removed.courses

        console.log('')
        console.log(`Cohortly demo seed complete${removed ? ' (previous demo workspace reset)' : ''}.`)
        console.log('')
        console.log(`Instructor   ${INSTRUCTOR.email}   (workspace ${result.instructor.accessStatus})`)
        for (const student of STUDENTS) console.log(`Student      ${student.email}   ${student.persona}`)
        console.log(`Password     ${process.env.DEMO_PASSWORD ? '(from DEMO_PASSWORD)' : password}`)
        console.log('')
        console.log(`Courses      ${counts.courses} (${counts.published} published, ${counts.drafts} draft)`)
        console.log(`Content      ${counts.sections} sections, ${counts.lessons} lessons, ${counts.quizzes} final quiz`)
        console.log(`Learning     ${counts.enrollments} enrollments, ${counts.completions} lesson completions, ${counts.quizAttempts} quiz attempts`)
        console.log(`Certificates ${counts.certificates}`)
        for (const certificate of result.certificates) {
            console.log(`  ${certificate.number}  ${certificate.course} (${certificate.student})  verify: /certificates/verify/${certificate.number}`)
        }
    }
} catch (error) {
    console.error(`Seed failed: ${error.message}`)
    process.exitCode = 1
} finally {
    await mongoose.disconnect()
}
