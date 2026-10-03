import mongoose from 'mongoose'
import transactionModel from '../models/transactionModel.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { badRequest, forbidden, notFound } from '../utils/httpError.js'
import { getEntitlementForUser, hasPaidBefore } from '../services/entitlement.js'
import { verifyNotificationSignature } from '../services/midtrans.js'
import { findReusablePayment, startCheckout } from '../services/payments.js'

// Maps a Midtrans transaction_status to our payment status. Returns null when the
// notification must not change anything (e.g. still pending, or a card payment
// held for fraud review).
const mapStatus = (body) => {
    switch (body.transaction_status) {
        case 'settlement':
            return 'success'
        case 'capture':
            return !body.fraud_status || body.fraud_status === 'accept' ? 'success' : null
        case 'deny':
        case 'cancel':
        case 'expire':
        case 'failure':
            return 'failed'
        default:
            return null
    }
}

// Midtrans server-to-server notification. Unauthenticated by nature, so
// authenticity is proven by the signature, and the amount must match our record.
//
// Idempotency: a payment moves pending -> success/failed with ONE atomic
// conditional update (`findOneAndUpdate({_id, status: 'pending'})`). Only the
// request that wins that update sets `paidAt`, and the access period is derived
// from paidAt, so a replayed or concurrent duplicate notification matches nothing
// and cannot grant a second period, reset the start, or alter an applied renewal.
export const handlePayment = asyncHandler(async (req, res) => {
    const body = req.body ?? {}

    if (!verifyNotificationSignature(body)) {
        throw forbidden('Invalid notification signature')
    }

    if (!mongoose.isValidObjectId(body.order_id)) {
        throw notFound('Unknown order')
    }

    const transaction = await transactionModel.findById(body.order_id)

    if (!transaction) throw notFound('Unknown order')

    if (Number(body.gross_amount) !== transaction.price) {
        throw badRequest('Amount mismatch')
    }

    const nextStatus = mapStatus(body)

    if (nextStatus) {
        await transactionModel.findOneAndUpdate(
            { _id: transaction._id, status: 'pending' },
            {
                $set: {
                    status: nextStatus,
                    providerStatus: body.transaction_status,
                    ...(nextStatus === 'success' ? { paidAt: new Date() } : {}),
                },
            }
        )
    } else {
        // intermediate status: note it for auditing while the order is still open
        await transactionModel.updateOne(
            { _id: transaction._id, status: 'pending' },
            { $set: { providerStatus: body.transaction_status } }
        )
    }

    return res.json({
        message: 'Handle Payment Success',
        data: {},
    })
})

// Lets an authenticated instructor start (or reuse) a payment for one more period.
// Allowed in every access state: NONE/PENDING/FAILED/EXPIRED recover, ACTIVE renews early.
// A renewal extends from the current expiry once the payment is confirmed; nothing
// changes in the entitlement until then.
export const checkout = asyncHandler(async (req, res) => {
    const entitlement = await getEntitlementForUser(req.user)
    const purpose = (await hasPaidBefore(req.user._id)) ? 'renewal' : 'activation'

    const reusable = await findReusablePayment(req.user._id)

    const paymentUrl = reusable
        ? reusable.paymentUrl
        : (await startCheckout(req.user, purpose)).paymentUrl

    return res.json({
        message: 'Checkout ready',
        data: {
            midtrans_payment_url: paymentUrl,
            purpose: reusable?.purpose ?? purpose,
            reused: Boolean(reusable),
            accessStatus: entitlement.accessStatus,
            accessExpiresAt: entitlement.accessExpiresAt,
        },
    })
})
