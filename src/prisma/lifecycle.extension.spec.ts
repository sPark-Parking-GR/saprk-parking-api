import { LifecycleStatus } from '@prisma/client'
import {
  ALL_LIFECYCLE_STATUSES,
  anyLifecycleStatus,
  withLifecycleFilter,
} from './lifecycle.extension'

describe('withLifecycleFilter', () => {
  it('injects the ACTIVE filter into findMany on a lifecycle model', () => {
    expect(withLifecycleFilter('Facility', 'findMany', { where: { operatorId: 'op1' } })).toEqual({
      where: { AND: [{ operatorId: 'op1' }, { lifecycleStatus: LifecycleStatus.ACTIVE }] },
    })
  })

  it('injects a bare filter when the query has no where at all', () => {
    expect(withLifecycleFilter('User', 'findMany', undefined)).toEqual({
      where: { lifecycleStatus: LifecycleStatus.ACTIVE },
    })
    expect(withLifecycleFilter('TariffPlan', 'count', {})).toEqual({
      where: { lifecycleStatus: LifecycleStatus.ACTIVE },
    })
  })

  it('spreads the filter into unique-where operations instead of wrapping in AND', () => {
    expect(withLifecycleFilter('Facility', 'findUnique', { where: { id: 'f1' } })).toEqual({
      where: { id: 'f1', lifecycleStatus: LifecycleStatus.ACTIVE },
    })
    expect(
      withLifecycleFilter('User', 'update', { where: { id: 'u1' }, data: { displayName: 'x' } }),
    ).toEqual({
      where: { id: 'u1', lifecycleStatus: LifecycleStatus.ACTIVE },
      data: { displayName: 'x' },
    })
    expect(withLifecycleFilter('ParkingOperator', 'delete', { where: { id: 'o1' } })).toEqual({
      where: { id: 'o1', lifecycleStatus: LifecycleStatus.ACTIVE },
    })
  })

  it('covers every read and bulk-write operation', () => {
    for (const operation of [
      'findMany',
      'findFirst',
      'findFirstOrThrow',
      'count',
      'aggregate',
      'groupBy',
      'updateMany',
      'deleteMany',
    ]) {
      const result = withLifecycleFilter('Facility', operation, { where: { rank: 1 } }) as {
        where: unknown
      }
      expect(result.where).toEqual({
        AND: [{ rank: 1 }, { lifecycleStatus: LifecycleStatus.ACTIVE }],
      })
    }
  })

  it('leaves a query alone when the caller states a lifecycle intent at top level', () => {
    const args = { where: { id: 'f1', lifecycleStatus: LifecycleStatus.ARCHIVED } }
    expect(withLifecycleFilter('Facility', 'findFirst', args)).toBe(args)

    const optOut = { where: { id: 'f1', lifecycleStatus: anyLifecycleStatus() } }
    expect(withLifecycleFilter('Facility', 'findFirst', optOut)).toBe(optOut)
  })

  it('detects a lifecycle intent inside a top-level AND', () => {
    const args = {
      where: { AND: [{ operatorId: 'op1' }, { lifecycleStatus: LifecycleStatus.TOMBSTONED }] },
    }
    expect(withLifecycleFilter('TariffPlan', 'findMany', args)).toBe(args)
  })

  it('never touches models without a lifecycle column', () => {
    const args = { where: { facilityId: 'f1' } }
    expect(withLifecycleFilter('Booking', 'findMany', args)).toBe(args)
    expect(withLifecycleFilter('Payment', 'count', args)).toBe(args)
  })

  it('never touches create, createMany or upsert', () => {
    const create = { data: { name: 'x' } }
    expect(withLifecycleFilter('Facility', 'create', create)).toBe(create)
    expect(withLifecycleFilter('Facility', 'createMany', create)).toBe(create)
    const upsert = { where: { id: 'o1' }, create: {}, update: {} }
    expect(withLifecycleFilter('ParkingOperator', 'upsert', upsert)).toBe(upsert)
  })

  it('opt-out helper enumerates every lifecycle state', () => {
    expect(anyLifecycleStatus().in).toEqual([...ALL_LIFECYCLE_STATUSES])
    expect(ALL_LIFECYCLE_STATUSES).toHaveLength(Object.values(LifecycleStatus).length)
  })
})
