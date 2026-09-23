import { isRevokedByWatermark } from './revocation'

const at = (iso: string) => new Date(iso)
const seconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

describe('isRevokedByWatermark', () => {
  it('treats a user who never revoked as always valid', () => {
    expect(isRevokedByWatermark(seconds('2020-01-01T00:00:00Z'), null)).toBe(false)
    expect(isRevokedByWatermark(seconds('2020-01-01T00:00:00Z'), undefined)).toBe(false)
  })

  it('revokes a token issued before the watermark', () => {
    expect(
      isRevokedByWatermark(seconds('2026-07-30T11:59:59Z'), at('2026-07-30T12:00:00.000Z')),
    ).toBe(true)
  })

  it('keeps a token issued in a strictly later second', () => {
    expect(
      isRevokedByWatermark(seconds('2026-07-30T12:00:01Z'), at('2026-07-30T12:00:00.900Z')),
    ).toBe(false)
  })

  it('fails closed on a same-second tie, whichever side the sub-second lands on', () => {
    for (const watermark of ['12:00:00.000', '12:00:00.400', '12:00:00.999']) {
      expect(
        isRevokedByWatermark(seconds('2026-07-30T12:00:00Z'), at(`2026-07-30T${watermark}Z`)),
      ).toBe(true)
    }
  })
})
