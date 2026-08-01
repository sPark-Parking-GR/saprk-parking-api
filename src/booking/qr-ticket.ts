import { createHmac, timingSafeEqual } from 'crypto'

export const QR_PAYLOAD_VERSION = 'v1'
export const QR_SIGNATURE_LENGTH = 22

/**
 * ±2 minutes of tolerance around server time. A phone's clock, an unsynchronised gate
 * terminal and the seconds a driver spends rolling up to the barrier all have to fit
 * inside it, and a rejected ticket at a barrier is a queue of cars. Wider would extend
 * how long a screenshot forwarded to somebody else keeps working, which is the entire
 * reason the code rotates; ±2 keeps a leaked frame useful for under five minutes and the
 * replay cache below makes even that single-use.
 */
export const QR_SKEW_MINUTES = 2

// Shape of the frozen payload contract: "v1.<bookingId>.<unixMinute>.<sig>". No dot is
// allowed inside a field, so the four parts are unambiguous.
export const QR_PAYLOAD_PATTERN = new RegExp(
  `^${QR_PAYLOAD_VERSION}\\.[A-Za-z0-9_-]{1,64}\\.\\d{1,15}\\.[A-Za-z0-9_-]{${QR_SIGNATURE_LENGTH}}$`,
)

export interface QrPayloadParts {
  bookingId: string
  unixMinute: number
  signature: string
}

export function currentUnixMinute(now: number = Date.now()): number {
  return Math.floor(now / 60_000)
}

export function signQrCode(qrSecret: string, bookingId: string, unixMinute: number): string {
  return createHmac('sha256', qrSecret)
    .update(`${bookingId}|${unixMinute}`)
    .digest('base64url')
    .slice(0, QR_SIGNATURE_LENGTH)
}

export function buildQrPayload(qrSecret: string, bookingId: string, unixMinute: number): string {
  const signature = signQrCode(qrSecret, bookingId, unixMinute)
  return `${QR_PAYLOAD_VERSION}.${bookingId}.${unixMinute}.${signature}`
}

export function parseQrPayload(payload: string): QrPayloadParts | null {
  if (!QR_PAYLOAD_PATTERN.test(payload)) return null

  const [, bookingId, minute, signature] = payload.split('.')
  const unixMinute = Number(minute)
  if (!bookingId || !signature || !Number.isSafeInteger(unixMinute)) return null

  return { bookingId, unixMinute, signature }
}

/**
 * Constant time, because a comparison that exits on the first wrong character is an
 * oracle: an attacker holding a booking id can time enough scans to recover the expected
 * signature one character at a time without ever learning qrSecret. Lengths are equal by
 * construction (both QR_SIGNATURE_LENGTH); the guard only stops timingSafeEqual throwing.
 */
export function signaturesMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function withinSkewWindow(unixMinute: number, serverMinute: number): boolean {
  return Math.abs(serverMinute - unixMinute) <= QR_SKEW_MINUTES
}

/**
 * The instant a payload minted for `unixMinute` stops being accepted anywhere: the last
 * server minute that still tolerates it is unixMinute + QR_SKEW_MINUTES, and that minute
 * runs out one minute later.
 */
export function payloadExpiresAt(unixMinute: number): Date {
  return new Date((unixMinute + QR_SKEW_MINUTES + 1) * 60_000)
}
