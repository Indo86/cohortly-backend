import mongoose from "mongoose";

// A transaction is a PAYMENT record (pending | success | failed). It is not the
// access state: access is derived from the successful ones (see
// utils/subscriptionPeriod.js).
const transactionModel = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    price: {
        type: Number,
        required: true,
    },
    status: {
        type: String,
        enum: ['pending', 'success', 'failed'],
        default: 'pending'
    },
    // what this payment is for: first activation or a later renewal
    purpose: {
        type: String,
        enum: ['activation', 'renewal'],
        default: 'activation'
    },
    // calendar months of access this payment buys, fixed when the order is created
    periodMonths: {
        type: Number,
        min: 1
    },
    // when the payment was confirmed. Set exactly once, by the atomic
    // pending -> success transition; it is also the idempotency marker:
    // a transaction can grant access at most once.
    paidAt: Date,
    // Midtrans hosted payment page for this order (null until the provider answers)
    paymentUrl: String,
    // last raw transaction_status received from Midtrans, for auditing
    providerStatus: String
}, {
    timestamps: true
})

export default mongoose.model('Transaction', transactionModel)
