import { getConfig } from '../config/env.js'

// Every user avatar (instructor or student) is stored in uploads/students.
export const AVATAR_FOLDER = 'students'

// Public URL of a user's avatar. Accounts that never uploaded one carry the 'default.png'
// placeholder, which has no file behind it, so they get null and the client shows initials.
export const userPhotoUrl = (name) =>
    !name || name === 'default.png' ? null : `${getConfig().appUrl}/uploads/${AVATAR_FOLDER}/${name}`
