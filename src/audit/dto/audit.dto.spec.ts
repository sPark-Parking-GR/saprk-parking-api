import { listAuditLogSchema } from './audit.dto'

describe('listAuditLogSchema', () => {
  it('defaults skip/take and leaves filters undefined when omitted', () => {
    const result = listAuditLogSchema.parse({})

    expect(result).toEqual({ skip: 0, take: 20 })
  })

  it('coerces and accepts actorId, action, entityType and entityId filters', () => {
    const result = listAuditLogSchema.parse({
      actorId: 'user-1',
      action: 'operator.suspended',
      entityType: 'ParkingOperator',
      entityId: 'op-1',
    })

    expect(result).toMatchObject({
      actorId: 'user-1',
      action: 'operator.suspended',
      entityType: 'ParkingOperator',
      entityId: 'op-1',
    })
  })

  it('accepts a well-formed createdFrom/createdTo range', () => {
    const result = listAuditLogSchema.safeParse({
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-01-31T00:00:00.000Z',
    })

    expect(result.success).toBe(true)
  })

  it('rejects an inverted date range', () => {
    const result = listAuditLogSchema.safeParse({
      createdFrom: '2026-02-01T00:00:00.000Z',
      createdTo: '2026-01-01T00:00:00.000Z',
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('createdFrom'))).toBe(true)
    }
  })

  it('rejects an empty actorId rather than treating it as absent', () => {
    const result = listAuditLogSchema.safeParse({ actorId: '' })

    expect(result.success).toBe(false)
  })
})
