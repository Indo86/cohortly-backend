import express from "express";
import { validateRequest } from "../middlewares/validateRequest.js";
import { changePasswordSchema, signInSchema, signUpSchema } from "../utils/schema.js";
import { changePassword, getMe, signInAction, signUpAction, updateAvatar } from "../controllers/authController.js";
import { uploadImage } from "../utils/multer.js";
import { AVATAR_FOLDER } from "../utils/photo.js";
import { authenticated } from "../middlewares/guards.js";
import { rateLimitFor } from "../middlewares/rateLimit.js";

const authRoutes = express.Router()

// rate limited before validation, so malformed or invalid attempts count as well
authRoutes.post('/sign-up', rateLimitFor('signUp'), validateRequest(signUpSchema), signUpAction)
authRoutes.post('/sign-in', rateLimitFor('signIn'), validateRequest(signInSchema), signInAction)
authRoutes.get('/me', authenticated, getMe)
// the signed-in user's own password (any role, any workspace state); wrong current passwords are rate limited
authRoutes.put('/me/password', authenticated, rateLimitFor('passwordChange'), validateRequest(changePasswordSchema), changePassword)
// the signed-in user's own avatar (any role, any workspace state), multipart field "avatar"
authRoutes.put('/me/avatar', authenticated, uploadImage(AVATAR_FOLDER, 'avatar'), updateAvatar)

export default authRoutes
