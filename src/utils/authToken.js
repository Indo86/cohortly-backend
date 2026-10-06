import jwt from 'jsonwebtoken'
import { getConfig } from '../config/env.js'

// Session tokens: HS256 JWTs valid for one day, payload { data: { id, pwdAt } }.
//
// Credential invalidation (M2 foundation, completed in M3): User.passwordChangedAt is set whenever a
// password is replaced. A token records the passwordChangedAt it was issued against (`pwdAt`, epoch
// milliseconds, or null when the password was never changed). verifyToken accepts a token only when
// that value still matches the account, so every token issued before a password change stops working
// at once, and a token issued after it (a new sign-in) works, even within the same second. No token
// list, blacklist or extra counter is stored: the timestamp itself is the version.
export const TOKEN_LIFETIME = '1 days'

export const credentialStamp = (user) => (user.passwordChangedAt ? new Date(user.passwordChangedAt).getTime() : null)

export const signSessionToken = (user) =>
    jwt.sign({ data: { id: user._id.toString(), pwdAt: credentialStamp(user) } }, getConfig().jwtSecret, {
        algorithm: 'HS256',
        expiresIn: TOKEN_LIFETIME,
    })

// true when the token was issued against the account's current password
export const matchesCurrentCredentials = (decoded, user) => {
    const current = credentialStamp(user)

    // never changed (accounts and tokens from before the marker existed keep working)
    if (current === null) return true

    return decoded?.data?.pwdAt === current
}
