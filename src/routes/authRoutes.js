import express from "express";
import { validateRequest } from "../middlewares/validateRequest.js";
import { signInSchema, signUpSchema } from "../utils/schema.js";
import { getMe, signInAction, signUpAction } from "../controllers/authController.js";
import { authenticated } from "../middlewares/guards.js";

const authRoutes = express.Router()

authRoutes.post('/sign-up', validateRequest(signUpSchema), signUpAction)
authRoutes.post('/sign-in', validateRequest(signInSchema), signInAction)
authRoutes.get('/me', authenticated, getMe)

export default authRoutes
