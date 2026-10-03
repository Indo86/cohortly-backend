import express from "express";
import { deleteStudent, getStudentById, getStudents, postStudent, updateStudent } from "../controllers/studentController.js";
import { instructorOnly } from "../middlewares/guards.js";
import { validateObjectId } from "../middlewares/validateRequest.js";
import { uploadImage } from "../utils/multer.js";

const studentRoutes = express.Router()

const uploadAvatar = uploadImage('students', 'avatar')

studentRoutes.get('/students', instructorOnly, getStudents)
studentRoutes.get('/students/:id', instructorOnly, validateObjectId('id'), getStudentById)

studentRoutes.post('/students', instructorOnly, uploadAvatar, postStudent)
studentRoutes.put('/students/:id', instructorOnly, validateObjectId('id'), uploadAvatar, updateStudent)
studentRoutes.delete('/students/:id', instructorOnly, validateObjectId('id'), deleteStudent)

export default studentRoutes
