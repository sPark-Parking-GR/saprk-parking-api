import type { PrismaService } from '../prisma/prisma.service'
import { SessionRevocationService } from './session-revocation.service'

const ISSUED_AT = Math.floor(new Date('2026-07-30T12:00:00.000Z').getTime() / 1000)

describe('SessionRevocationService', () => {
  let prisma: { user: { findUnique: jest.Mock } }
  let service: SessionRevocationService

  const watermark = (value: Date | null) =>
    prisma.user.findUnique.mockResolvedValue({ sessionsValidFrom: value, deletedAt: null })

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } }
    service = new SessionRevocationService(prisma as unknown as PrismaService)
  })

  it('reads the watermark with a single primary-key lookup', async () => {
    watermark(null)
    await service.isRevoked('u1', ISSUED_AT)

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1)
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { sessionsValidFrom: true, deletedAt: true },
    })
  })

  it('accepts a token when the user has never revoked', async () => {
    watermark(null)
    await expect(service.isRevoked('u1', ISSUED_AT)).resolves.toBe(false)
  })

  it('rejects a token issued before the watermark', async () => {
    watermark(new Date('2026-07-30T12:05:00.000Z'))
    await expect(service.isRevoked('u1', ISSUED_AT)).resolves.toBe(true)
  })

  it('accepts a token issued after the watermark', async () => {
    watermark(new Date('2026-07-30T11:55:00.000Z'))
    await expect(service.isRevoked('u1', ISSUED_AT)).resolves.toBe(false)
  })

  it('fails closed on a same-second tie', async () => {
    watermark(new Date('2026-07-30T12:00:00.900Z'))
    await expect(service.isRevoked('u1', ISSUED_AT)).resolves.toBe(true)
  })

  it('fails closed when the user row is gone', async () => {
    prisma.user.findUnique.mockResolvedValue(null)
    await expect(service.isRevoked('deleted', ISSUED_AT)).resolves.toBe(true)
  })

  // The tombstone left behind by account deletion keeps its row, so the missing-row check
  // above never fires for it — this is what stops it authenticating.
  it('rejects a deleted account even with a token newer than the watermark', async () => {
    prisma.user.findUnique.mockResolvedValue({
      sessionsValidFrom: new Date('2026-07-30T11:55:00.000Z'),
      deletedAt: new Date('2026-07-30T11:55:00.000Z'),
    })
    await expect(service.isRevoked('u1', ISSUED_AT)).resolves.toBe(true)
  })
})
