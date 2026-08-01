import { createHmac } from 'crypto'
import {
  QR_PAYLOAD_PATTERN,
  QR_SIGNATURE_LENGTH,
  QR_SKEW_MINUTES,
  buildQrPayload,
  currentUnixMinute,
  parseQrPayload,
  payloadExpiresAt,
  signQrCode,
  signaturesMatch,
  withinSkewWindow,
} from './qr-ticket'

const SECRET = 'ZmFrZS1xci1zZWNyZXQtZm9yLXRlc3RzLW9ubHktMDAwMDAw'
const BOOKING_ID = 'ckbooking000000000000001'
const MINUTE = 29_500_000

describe('QR ticket contract', () => {
  it('signs exactly the frozen preimage bookingId|unixMinute', () => {
    const expected = createHmac('sha256', SECRET)
      .update(`${BOOKING_ID}|${MINUTE}`)
      .digest('base64url')
      .slice(0, QR_SIGNATURE_LENGTH)

    expect(signQrCode(SECRET, BOOKING_ID, MINUTE)).toBe(expected)
  })

  it('emits v1.<bookingId>.<unixMinute>.<sig> with a 22 character signature', () => {
    const payload = buildQrPayload(SECRET, BOOKING_ID, MINUTE)
    const [version, bookingId, minute, signature] = payload.split('.')

    expect(version).toBe('v1')
    expect(bookingId).toBe(BOOKING_ID)
    expect(minute).toBe(String(MINUTE))
    expect(signature).toHaveLength(QR_SIGNATURE_LENGTH)
    expect(QR_PAYLOAD_PATTERN.test(payload)).toBe(true)
  })

  it('round-trips through the parser', () => {
    expect(parseQrPayload(buildQrPayload(SECRET, BOOKING_ID, MINUTE))).toEqual({
      bookingId: BOOKING_ID,
      unixMinute: MINUTE,
      signature: signQrCode(SECRET, BOOKING_ID, MINUTE),
    })
  })

  it.each([
    ['wrong version', `v2.${BOOKING_ID}.${MINUTE}.${signQrCode(SECRET, BOOKING_ID, MINUTE)}`],
    ['missing signature', `v1.${BOOKING_ID}.${MINUTE}`],
    ['short signature', `v1.${BOOKING_ID}.${MINUTE}.abc`],
    ['non numeric minute', `v1.${BOOKING_ID}.later.${signQrCode(SECRET, BOOKING_ID, MINUTE)}`],
    ['empty', ''],
  ])('rejects a %s payload', (_label, payload) => {
    expect(parseQrPayload(payload)).toBeNull()
  })

  it('changes the signature when the minute changes, so the code rotates', () => {
    expect(signQrCode(SECRET, BOOKING_ID, MINUTE)).not.toBe(
      signQrCode(SECRET, BOOKING_ID, MINUTE + 1),
    )
  })

  it('changes the signature when the secret changes, so one booking cannot sign another', () => {
    expect(signQrCode(SECRET, BOOKING_ID, MINUTE)).not.toBe(
      signQrCode(`${SECRET}x`, BOOKING_ID, MINUTE),
    )
  })

  it('matches identical signatures and rejects tampered or mis-sized ones', () => {
    const signature = signQrCode(SECRET, BOOKING_ID, MINUTE)
    const tampered = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`

    expect(signaturesMatch(signature, signature)).toBe(true)
    expect(signaturesMatch(tampered, signature)).toBe(false)
    expect(signaturesMatch(signature.slice(0, 10), signature)).toBe(false)
  })

  it('accepts ±2 minutes around server time and nothing beyond', () => {
    const server = MINUTE

    for (let offset = -QR_SKEW_MINUTES; offset <= QR_SKEW_MINUTES; offset++) {
      expect(withinSkewWindow(server + offset, server)).toBe(true)
    }
    expect(withinSkewWindow(server - QR_SKEW_MINUTES - 1, server)).toBe(false)
    expect(withinSkewWindow(server + QR_SKEW_MINUTES + 1, server)).toBe(false)
  })

  it('reports expiry at the end of the last minute that still tolerates the payload', () => {
    expect(payloadExpiresAt(MINUTE).getTime()).toBe((MINUTE + QR_SKEW_MINUTES + 1) * 60_000)
  })

  it('derives the current minute by flooring epoch milliseconds', () => {
    expect(currentUnixMinute(MINUTE * 60_000 + 59_999)).toBe(MINUTE)
    expect(currentUnixMinute(MINUTE * 60_000 + 60_000)).toBe(MINUTE + 1)
  })
})
