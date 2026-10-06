import express from "express";
import {
    addQuestion, createQuiz, deleteQuestion, deleteQuiz, getCourseQuiz, reorderQuestions, updateQuestion, updateQuiz,
} from "../controllers/quizController.js";
import { getMyCertificate, getMyCertificates, verifyCertificate } from "../controllers/certificateController.js";
import { instructorOnly } from "../middlewares/guards.js";
import { requireRole } from "../middlewares/requireRole.js";
import { verifyToken } from "../middlewares/verifyToken.js";
import { validateObjectId, validateRequest } from "../middlewares/validateRequest.js";
import { quizQuestionSchema, quizSettingsSchema, reorderQuestionsSchema } from "../utils/schema.js";
import { ROLES } from "../utils/roles.js";
import { rateLimitFor } from "../middlewares/rateLimit.js";

// Final quiz management (INSTRUCTOR + ACTIVE workspace + ownership through the course) and the
// certificate endpoints. The student quiz endpoints live in learningRoutes.js.
const quizRoutes = express.Router()

quizRoutes.get('/courses/:courseId/quiz', instructorOnly, validateObjectId('courseId'), getCourseQuiz)
quizRoutes.post('/courses/:courseId/quiz', instructorOnly, validateObjectId('courseId'), validateRequest(quizSettingsSchema), createQuiz)

quizRoutes.put('/quizzes/:quizId', instructorOnly, validateObjectId('quizId'), validateRequest(quizSettingsSchema), updateQuiz)
quizRoutes.delete('/quizzes/:quizId', instructorOnly, validateObjectId('quizId'), deleteQuiz)

quizRoutes.post('/quizzes/:quizId/questions', instructorOnly, validateObjectId('quizId'), validateRequest(quizQuestionSchema), addQuestion)
// `reorder` is declared before `:questionId` so it is never read as a question id
quizRoutes.patch('/quizzes/:quizId/questions/reorder', instructorOnly, validateObjectId('quizId'), validateRequest(reorderQuestionsSchema), reorderQuestions)
quizRoutes.put('/quizzes/:quizId/questions/:questionId', instructorOnly, validateObjectId('quizId', 'questionId'), validateRequest(quizQuestionSchema), updateQuestion)
quizRoutes.delete('/quizzes/:quizId/questions/:questionId', instructorOnly, validateObjectId('quizId', 'questionId'), deleteQuestion)

// A student's own certificates: authenticated STUDENT, deliberately NO active-workspace gate
// (an issued certificate is a historical record, see controllers/certificateController.js).
const ownCertificate = [verifyToken, requireRole(ROLES.STUDENT)]

quizRoutes.get('/my-certificates', ownCertificate, getMyCertificates)
quizRoutes.get('/my-certificates/:certificateNumber', ownCertificate, getMyCertificate)

// PUBLIC verification: no authentication, safe fields only, rate limited per address.
quizRoutes.get('/certificates/verify/:certificateNumber', rateLimitFor('certificateVerify'), verifyCertificate)

export default quizRoutes
