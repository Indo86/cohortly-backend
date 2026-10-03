import express from "express";
import { completeLesson, getLesson, getMyCourse, getMyCourses, undoLessonCompletion } from "../controllers/learningController.js";
import { studentOnly } from "../middlewares/guards.js";
import { getQuizAttempts, getStudentQuiz, submitQuizAttempt } from "../controllers/quizLearningController.js";
import { validateObjectId, validateRequest } from "../middlewares/validateRequest.js";
import { quizAttemptSchema } from "../utils/schema.js";

// Student learning API: STUDENT role + ACTIVE instructor workspace (studentOnly), then
// enrolled + published course (checked in the handlers).
const learningRoutes = express.Router()

learningRoutes.get('/students-courses', studentOnly, getMyCourses)
learningRoutes.get('/students-courses/:courseId', studentOnly, validateObjectId('courseId'), getMyCourse)
learningRoutes.get('/students-courses/:courseId/lessons/:lessonId', studentOnly, validateObjectId('courseId', 'lessonId'), getLesson)

// final quiz: same gate as the lessons (STUDENT + ACTIVE workspace + enrolled + published course)
learningRoutes.get('/students-courses/:courseId/quiz', studentOnly, validateObjectId('courseId'), getStudentQuiz)
learningRoutes.post('/students-courses/:courseId/quiz/attempts', studentOnly, validateObjectId('courseId'), validateRequest(quizAttemptSchema), submitQuizAttempt)
learningRoutes.get('/students-courses/:courseId/quiz/attempts', studentOnly, validateObjectId('courseId'), getQuizAttempts)

learningRoutes.put('/lessons/:lessonId/completion', studentOnly, validateObjectId('lessonId'), completeLesson)
learningRoutes.delete('/lessons/:lessonId/completion', studentOnly, validateObjectId('lessonId'), undoLessonCompletion)

export default learningRoutes
