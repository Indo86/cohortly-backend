import express from "express";
import { getOverviews } from "../controllers/overviewController.js";
import { instructorOnly } from "../middlewares/guards.js";

const overviewRoutes = express.Router()

overviewRoutes.get('/overviews', instructorOnly, getOverviews)

export default overviewRoutes
