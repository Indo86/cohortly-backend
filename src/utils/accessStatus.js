// Workspace entitlement states. These describe ACCESS, not a payment: a
// transaction is pending | success | failed, access is one of these five.
export const ACCESS = Object.freeze({
    NONE: 'NONE',
    PENDING: 'PENDING',
    ACTIVE: 'ACTIVE',
    FAILED: 'FAILED',
    EXPIRED: 'EXPIRED',
})
