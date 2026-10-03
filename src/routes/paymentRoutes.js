import express from "express";
import { checkout, handlePayment } from "../controllers/paymentController.js";
import { verifyToken } from "../middlewares/verifyToken.js";
import { requireRole } from "../middlewares/requireRole.js";
import { ROLES } from "../utils/roles.js";

const paymentRoutes = express.Router()

// Midtrans server-to-server notification (authenticity = signature, not a JWT)
paymentRoutes.post('/handle-payment-midtrans', handlePayment)

// (Re)start payment for an instructor whose workspace is not active yet
paymentRoutes.post('/payment/checkout', verifyToken, requireRole(ROLES.INSTRUCTOR), checkout)

export default paymentRoutes
