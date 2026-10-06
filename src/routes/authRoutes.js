import express from "express";
import { validateRequest } from "../middlewares/validateRequest.js";
import { signInSchema, signUpSchema } from "../utils/schema.js";
import { getMe, signInAction, signUpAction } from "../controllers/authController.js";
import { authenticated } from "../middlewares/guards.js";
import { rateLimitFor } from "../middlewares/rateLimit.js";

const authRoutes = express.Router()

// rate limited before validation, so malformed or invalid attempts count as well
authRoutes.post('/sign-up', rateLimitFor('signUp'), validateRequest(signUpSchema), signUpAction)
authRoutes.post('/sign-in', rateLimitFor('signIn'), validateRequest(signInSchema), signInAction)
authRoutes.get('/me', authenticated, getMe)

export default authRoutes
