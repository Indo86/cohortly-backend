import crypto from 'node:crypto'

// COH-<year>-<8 characters>. The characters are random (40 bits) from an alphabet without the
// easily confused 0/O/1/I/L/U, so the number carries no personal data, no sequence and no database
// id, is easy to read out and type, and collisions are caught by the unique index (the issuer
// simply tries again).
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CERTIFICATE_NUMBER_PATTERN = /^COH-\d{4}-[2-9A-HJKMNP-TV-Z]{8}$/

export const generateCertificateNumber = (now = new Date()) => {
    const bytes = crypto.randomBytes(8)
    let code = ''

    for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length]

    return `COH-${now.getUTCFullYear()}-${code}`
}
