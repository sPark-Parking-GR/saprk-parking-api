import { randomBytes } from 'crypto'

// Crockford-style base32. I, L, O and U are absent: operators dictate access codes over
// the phone, where I/1 and O/0 are routinely misheard, and dropping U keeps the generator
// from spelling words at a customer. 16 random bytes (128 bits) replaces the previous 4:
// at 32 bits a birthday collision on the UNIQUE column was expected around 77k bookings,
// turning ordinary growth into P2002 failures on a column nobody looks at.
export const ACCESS_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const ACCESS_CODE_BYTES = 16
// 128 bits packed 5 at a time: 25 full groups plus one carrying the leftover 3 bits.
export const ACCESS_CODE_LENGTH = 26

const QR_SECRET_BYTES = 32

export function generateAccessCode(): string {
  const bytes = randomBytes(ACCESS_CODE_BYTES)
  let buffer = 0
  let bits = 0
  let code = ''

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      code += ACCESS_CODE_ALPHABET[(buffer >>> bits) & 31]
    }
  }
  if (bits > 0) code += ACCESS_CODE_ALPHABET[(buffer << (5 - bits)) & 31]

  return code
}

/**
 * The QR credential, minted at confirm time. Independent of the access code by
 * construction and never derived from it: the access code is printed on receipts,
 * dictated over the phone and searchable in the ops board, so a QR token hashed out of
 * it would be forgeable by everyone who has ever seen the code — which was exactly the
 * flaw in the sha256(accessCode) scheme this replaces. Stored in full rather than
 * hashed because rotating QR codes are computed from the secret server-side.
 */
export function generateQrSecret(): string {
  return randomBytes(QR_SECRET_BYTES).toString('base64url')
}
