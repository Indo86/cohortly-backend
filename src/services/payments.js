import mongoose from 'mongoose'
import transactionModel from '../models/transactionModel.js'
import { getConfig } from '../config/env.js'
import { createPayment } from './midtrans.js'

const REUSE_WINDOW_MS = 20 * 60 * 1000

// Creates a pending transaction for the user and a hosted payment page for it.
//
// Consistency model (Midtrans is external, so this is compensation, not a
// distributed transaction):
//  1. the pending transaction is persisted first, with a pre-generated id used
//     as the Midtrans order_id;
//  2. the provider is called;
//  3. on success the payment URL is stored on the transaction;
//  4. on failure the transaction is removed again and the error propagates, so
//     no "pending with no payment page" record is left behind.
// A crash between 1 and 3 leaves a pending transaction without URL; the
// instructor recovers with POST /api/payment/checkout.
export const startCheckout = async (user, purpose = 'activation') => {
    const { subscriptionPrice, subscriptionPeriodMonths } = getConfig()

    const transaction = new transactionModel({
        _id: new mongoose.Types.ObjectId(),
        user: user._id,
        price: subscriptionPrice,
        purpose,
        // fixed now, so a later config change never alters what this order buys
        periodMonths: subscriptionPeriodMonths,
    })

    await transaction.save()

    try {
        const { paymentUrl } = await createPayment({
            orderId: transaction._id.toString(),
            amount: transaction.price,
            email: user.email,
        })

        transaction.paymentUrl = paymentUrl
        await transaction.save()

        return { transaction, paymentUrl }
    } catch (error) {
        await transactionModel.deleteOne({ _id: transaction._id })
        throw error
    }
}

// Reuses a recent pending payment page instead of creating a new order on every retry.
export const findReusablePayment = (userId) =>
    transactionModel.findOne({
        user: userId,
        status: 'pending',
        paymentUrl: { $exists: true, $ne: null },
        createdAt: { $gte: new Date(Date.now() - REUSE_WINDOW_MS) },
    })
