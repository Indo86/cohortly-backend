import express from "express";
import { deleteCourse, deleteStudentToCourse, getCategories, getCourseById, getCourses, getStudentsByCourseId, postCourse, postStudentToCourse, updateCourse, updateCourseStatus } from "../controllers/courseController.js";
import { createSection, listSections, reorderSections } from "../controllers/sectionController.js";
import { getCourseProgress } from "../controllers/progressController.js";
import { authenticated, instructorOnly } from "../middlewares/guards.js";
import { uploadImage } from "../utils/multer.js";
import { validateObjectId, validateRequest } from "../middlewares/validateRequest.js";
import { addStudentCourseSchema, courseStatusSchema, reorderSectionsSchema, sectionSchema } from "../utils/schema.js";

const courseRoutes = express.Router()

const uploadThumbnail = uploadImage('courses', 'thumbnail')

courseRoutes.get('/courses', instructorOnly, getCourses)
courseRoutes.get('/categories', authenticated, getCategories)
courseRoutes.get('/courses/:id', instructorOnly, validateObjectId('id'), getCourseById)
courseRoutes.post('/courses', instructorOnly, uploadThumbnail, postCourse)
courseRoutes.put('/courses/:id', instructorOnly, validateObjectId('id'), uploadThumbnail, updateCourse)
courseRoutes.put('/courses/:id/status', instructorOnly, validateObjectId('id'), validateRequest(courseStatusSchema), updateCourseStatus)
courseRoutes.delete('/courses/:id', instructorOnly, validateObjectId('id'), deleteCourse)

// sections of a course (instructor, owned course)
courseRoutes.get('/courses/:courseId/sections', instructorOnly, validateObjectId('courseId'), listSections)
courseRoutes.post('/courses/:courseId/sections', instructorOnly, validateObjectId('courseId'), validateRequest(sectionSchema), createSection)
courseRoutes.patch('/courses/:courseId/sections/reorder', instructorOnly, validateObjectId('courseId'), validateRequest(reorderSectionsSchema), reorderSections)

// learner progress of a course (instructor, owned course)
courseRoutes.get('/courses/:courseId/progress', instructorOnly, validateObjectId('courseId'), getCourseProgress)

courseRoutes.get('/courses/students/:id', instructorOnly, validateObjectId('id'), getStudentsByCourseId)
courseRoutes.post('/courses/students/:id', instructorOnly, validateObjectId('id'), validateRequest(addStudentCourseSchema), postStudentToCourse)
courseRoutes.put('/courses/students/:id', instructorOnly, validateObjectId('id'), validateRequest(addStudentCourseSchema), deleteStudentToCourse)

export default courseRoutes
