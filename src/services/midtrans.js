import crypto from 'crypto'
import { getConfig, getMidtransServerKey } from '../config/env.js'
import { HttpError } from '../utils/httpError.js'

const PROVIDER_TIMEOUT_MS = 10000

// Creates a hosted payment page for one order. Throws HttpError(502/503) on any
// failure so callers can run their compensating cleanup.
export const createPayment = async ({ orderId, amount, email }) => {
    const { midtransUrl, midtransAuthString, frontendUrl } = getConfig()

    if (!midtransUrl || !midtransAuthString) {
        throw new HttpError(503, 'Payments are not configured')
    }

    let response

    try {
        response = await fetch(midtransUrl, {
            method: 'POST',
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Basic ${midtransAuthString}`,
            },
            body: JSON.stringify({
                transaction_details: {
                    order_id: orderId,
                    gross_amount: amount,
                },
                credit_card: { secure: true },
                customer_details: { email },
                callbacks: { finish: `${frontendUrl}/success-checkout` },
            }),
        })
    } catch (error) {
        console.error('Midtrans request failed:', error.name)
        throw new HttpError(502, 'Payment provider is unavailable, please try again')
    }

    let payload = null

    try {
        payload = await response.json()
    } catch {
        // handled below
    }

    if (!response.ok || !payload?.redirect_url) {
        console.error('Midtrans rejected the request, status', response.status)
        throw new HttpError(502, 'Payment provider could not create the payment')
    }

    return { paymentUrl: payload.redirect_url }
}

// Midtrans notification authenticity:
// signature_key = SHA512(order_id + status_code + gross_amount + ServerKey)
// https://docs.midtrans.com/docs/https-notification-webhooks
export const verifyNotificationSignature = (body) => {
    const serverKey = getMidtransServerKey()

    if (!serverKey) return false // fail closed when not configured

    const { order_id, status_code, gross_amount, signature_key } = body ?? {}

    if (
        [order_id, status_code, gross_amount, signature_key].some(
            (value) => typeof value !== 'string' || value.length === 0
        )
    ) {
        return false
    }

    const expected = crypto
        .createHash('sha512')
        .update(`${order_id}${status_code}${gross_amount}${serverKey}`)
        .digest('hex')

    const received = Buffer.from(signature_key.toLowerCase())
    const wanted = Buffer.from(expected)

    return received.length === wanted.length && crypto.timingSafeEqual(received, wanted)
}
