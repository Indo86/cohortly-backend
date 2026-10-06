import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, changePasswordSchema, mutateStudentSchema, passwordSchema, signInSchema, signUpSchema,
    updateStudentSchema,
} from '../src/utils/schema.js'

// The password policy for NEW passwords (utils/schema.js passwordSchema): 8 to 72 characters, no
// arbitrary complexity rules. Sign-in is not subject to it, so existing accounts keep working.
const signUp = (password) => signUpSchema.safeParse({ name: 'Company Owner', email: 'owner@test.dev', password })
const createStudent = (password) => mutateStudentSchema.safeParse({ name: 'Student Name', email: 'student@test.dev', password })
const editStudent = (password) => updateStudentSchema.safeParse({ name: 'Student Name', email: 'student@test.dev', password })
const errorOf = (result) => result.error.issues.find((issue) => issue.path[0] === 'password')?.message

describe('password policy', () => {
    it('is 8 to 72 characters', () => {
        assert.equal(PASSWORD_MIN_LENGTH, 8)
        assert.equal(PASSWORD_MAX_LENGTH, 72)
        assert.equal(passwordSchema.safeParse('a'.repeat(7)).success, false)
        assert.equal(passwordSchema.safeParse('a'.repeat(8)).success, true)
        assert.equal(passwordSchema.safeParse('a'.repeat(72)).success, true)
        assert.equal(passwordSchema.safeParse('a'.repeat(73)).success, false)
    })

    it('asks for length, not for character classes', () => {
        for (const password of ['abcdefgh', '12345678', 'correct horse battery staple']) {
            assert.equal(passwordSchema.safeParse(password).success, true, password)
        }
    })

    it('applies to sign-up', () => {
        assert.equal(signUp('short12').success, false)
        assert.equal(errorOf(signUp('short12')), 'Use a password of at least 8 characters')
        assert.equal(signUp('long-enough').success, true)
    })

    it('applies to students created by an instructor', () => {
        assert.equal(createStudent('1234567').success, false)
        assert.equal(createStudent('12345678').success, true)
    })

    it('applies to a new password set on a student edit; no password still means "keep the current one"', () => {
        assert.equal(editStudent('1234567').success, false)
        assert.equal(editStudent('12345678').success, true)

        for (const keep of [undefined, '', 'undefined', 'null', null]) {
            const result = editStudent(keep)

            assert.equal(result.success, true, String(keep))
            assert.equal(result.data.password, undefined)
        }
    })

    it('rejects passwords bcrypt would truncate', () => {
        assert.equal(errorOf(signUp('a'.repeat(73))), 'Use a password of at most 72 characters')
    })

    it('does not apply to sign-in: accounts created under the old 5-character minimum can still sign in', () => {
        assert.equal(signInSchema.safeParse({ email: 'old@test.dev', password: 'abc12' }).success, true)
        assert.equal(signInSchema.safeParse({ email: 'old@test.dev', password: '' }).success, false)
    })
})

describe('change-password body (M3)', () => {
    const change = (body) => changePasswordSchema.safeParse(body)
    const pathsOf = (result) => result.error.issues.map((issue) => issue.path.join('.'))

    it('needs the current password and a new password that follows the policy', () => {
        assert.equal(change({ currentPassword: 'old-password', newPassword: 'new-password' }).success, true)
        assert.deepEqual(pathsOf(change({ newPassword: 'new-password' })), ['currentPassword'])
        assert.deepEqual(pathsOf(change({ currentPassword: '', newPassword: 'new-password' })), ['currentPassword'])
        assert.deepEqual(pathsOf(change({ currentPassword: 'old-password', newPassword: 'short' })), ['newPassword'])
        assert.deepEqual(pathsOf(change({ currentPassword: 'old-password' })), ['newPassword'])
    })

    it('refuses a new password equal to the current one', () => {
        const result = change({ currentPassword: 'same-password', newPassword: 'same-password' })

        assert.deepEqual(pathsOf(result), ['newPassword'])
        assert.equal(result.error.issues[0].message, 'Choose a new password that is different from the current one')
    })

    it('ignores any other field (no user id can be smuggled in)', () => {
        const result = change({ currentPassword: 'old-password', newPassword: 'new-password', userId: '64b64b64b64b64b64b64b64b', role: 'manager' })

        assert.deepEqual(Object.keys(result.data).sort(), ['currentPassword', 'newPassword'])
    })
})
