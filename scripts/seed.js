// Idempotent bootstrap for a fresh database.
//   npm run seed        -> categories only (safe for any environment)
//   npm run seed:demo   -> categories + a demo instructor (ACTIVE) and demo student
// Running it repeatedly is safe: existing records are left untouched.
import 'dotenv/config'
import bcrypt from 'bcrypt'
import mongoose from 'mongoose'

import categoryModel from '../src/models/categoryModel.js'
import userModel from '../src/models/userModel.js'
import transactionModel from '../src/models/transactionModel.js'
import { ensureUploadDirs } from '../src/config/paths.js'
import { ROLES } from '../src/utils/roles.js'
import { ACCESS } from '../src/utils/accessStatus.js'
import { getInstructorEntitlement } from '../src/services/entitlement.js'

const CATEGORIES = [
    'Programming',
    'Data Science',
    'Design',
    'Business',
    'Marketing',
    'Languages',
    'Leadership',
    'Cyber Security',
]

const withDemo = process.argv.includes('--demo')

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required')
    process.exit(1)
}

if (withDemo && process.env.NODE_ENV === 'production') {
    console.error('Refusing to create demo accounts when NODE_ENV=production')
    process.exit(1)
}

await mongoose.connect(process.env.DATABASE_URL)

ensureUploadDirs()

for (const name of CATEGORIES) {
    await categoryModel.updateOne({ name }, { $setOnInsert: { name } }, { upsert: true })
}

console.log(`Categories ensured: ${CATEGORIES.length}`)

if (withDemo) {
    const password = process.env.DEMO_PASSWORD || 'demo-password-123'

    const accounts = [
        { name: 'Demo Instructor', email: 'instructor@demo.local', role: ROLES.INSTRUCTOR },
        { name: 'Demo Student', email: 'student@demo.local', role: ROLES.STUDENT },
    ]

    let instructor

    for (const account of accounts) {
        let user = await userModel.findOne({ email: account.email })

        if (!user) {
            user = await userModel.create({
                ...account,
                photo: 'default.png',
                password: await bcrypt.hash(password, 12),
                manager: account.role === ROLES.STUDENT ? instructor?._id : undefined,
            })
            console.log(`Created ${account.role} ${account.email}`)
        } else {
            console.log(`Exists  ${account.role} ${account.email}`)
        }

        if (account.role === ROLES.INSTRUCTOR) instructor = user
    }

    // Access is time-bounded, so re-running the seed after the demo period has
    // ended grants a fresh demo period (idempotent while the workspace is ACTIVE).
    const { accessStatus, accessExpiresAt } = await getInstructorEntitlement(instructor._id)

    if (accessStatus !== ACCESS.ACTIVE) {
        await transactionModel.create({
            user: instructor._id,
            price: 0,
            status: 'success',
            purpose: 'activation',
            periodMonths: 1,
            paidAt: new Date(),
            providerStatus: 'demo-seed',
        })
        console.log('Demo instructor workspace activated for one period (no payment)')
    } else {
        console.log(`Demo workspace already ACTIVE until ${accessExpiresAt.toISOString()}`)
    }

    console.log(`Demo password: ${process.env.DEMO_PASSWORD ? '(from DEMO_PASSWORD)' : password}`)
}

await mongoose.disconnect()
