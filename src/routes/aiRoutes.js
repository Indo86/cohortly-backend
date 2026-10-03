import express from "express";
import { askLessonQuestion, createPracticeQuestions, createQuizDraft, getStatus, summarizeLessonText } from "../controllers/aiController.js";
import { instructorOnly, studentOnly } from "../middlewares/guards.js";
import { verifyToken } from "../middlewares/verifyToken.js";
import { validateObjectId, validateRequest } from "../middlewares/validateRequest.js";
import { aiQuestionSchema, aiQuizDraftSchema } from "../utils/schema.js";

// Optional AI assistance (M9). Same guards as the features they belong to: AI never widens access.
// The body of every route is validated and contains ONLY user data (a question, a count, a focus):
// there is no field for a system prompt, a provider or a model.
const aiRoutes = express.Router()

// configuration state for the UI; any signed-in user, no entitlement needed, never calls the provider
aiRoutes.get('/ai/status', verifyToken, getStatus)

// student: one accessible lesson (STUDENT + ACTIVE workspace + enrolled + published course)
aiRoutes.post('/students-courses/:courseId/lessons/:lessonId/ai/question', studentOnly, validateObjectId('courseId', 'lessonId'), validateRequest(aiQuestionSchema), askLessonQuestion)
aiRoutes.post('/students-courses/:courseId/lessons/:lessonId/ai/summary', studentOnly, validateObjectId('courseId', 'lessonId'), summarizeLessonText)
aiRoutes.post('/students-courses/:courseId/lessons/:lessonId/ai/practice', studentOnly, validateObjectId('courseId', 'lessonId'), createPracticeQuestions)

// instructor: a quiz DRAFT from an owned course (INSTRUCTOR + ACTIVE workspace)
aiRoutes.post('/courses/:courseId/quiz/ai-draft', instructorOnly, validateObjectId('courseId'), validateRequest(aiQuizDraftSchema), createQuizDraft)

export default aiRoutes
