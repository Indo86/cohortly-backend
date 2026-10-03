import express from "express";
import { deleteSectionAction, updateSection } from "../controllers/sectionController.js";
import { createLesson, deleteLessonAction, getLesson, reorderLessons, updateLesson } from "../controllers/lessonController.js";
import { instructorOnly } from "../middlewares/guards.js";
import { validateObjectId, validateRequest } from "../middlewares/validateRequest.js";
import { lessonSchema, reorderLessonsSchema, sectionSchema } from "../utils/schema.js";

// Instructor management of sections and lessons (INSTRUCTOR + ACTIVE workspace +
// ownership through the course). Student completion lives in learningRoutes.js.
const structureRoutes = express.Router()

structureRoutes.put('/sections/:sectionId', instructorOnly, validateObjectId('sectionId'), validateRequest(sectionSchema), updateSection)
structureRoutes.delete('/sections/:sectionId', instructorOnly, validateObjectId('sectionId'), deleteSectionAction)

structureRoutes.post('/sections/:sectionId/lessons', instructorOnly, validateObjectId('sectionId'), validateRequest(lessonSchema), createLesson)
structureRoutes.patch('/sections/:sectionId/lessons/reorder', instructorOnly, validateObjectId('sectionId'), validateRequest(reorderLessonsSchema), reorderLessons)

structureRoutes.get('/lessons/:lessonId', instructorOnly, validateObjectId('lessonId'), getLesson)
structureRoutes.put('/lessons/:lessonId', instructorOnly, validateObjectId('lessonId'), validateRequest(lessonSchema), updateLesson)
structureRoutes.delete('/lessons/:lessonId', instructorOnly, validateObjectId('lessonId'), deleteLessonAction)

export default structureRoutes
