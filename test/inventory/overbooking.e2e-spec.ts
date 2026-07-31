import { BookingStatus, FacilityKind, Prisma } from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import {
  FacilityNotBookableError,
  NoAvailabilityError,
} from '../../src/common/errors/domain.errors'
import { InventoryService } from '../../src/inventory/inventory.service'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { truncateAll } from '../utils/db'
import { seedFacility, seedOperator, seedUser } from '../utils/seed'
import { createTestApp } from '../utils/test-app'

const STARTS_AT = new Date('2026-09-01T10:00:00.000Z')
const ENDS_AT = new Date('2026-09-01T12:00:00.000Z')
const RACERS = 12

// Prisma's code for a transaction the database aborted: 40001 serialization_failure and
// 40P01 deadlock_detected both surface here.
const TRANSACTION_CONFLICT = 'P2034'

interface Outcome {
  admitted: number
  noAvailability: number
  serializationConflict: number
  unexpected: unknown[]
}

function summarise(results: Array<PromiseSettledResult<unknown>>): Outcome {
  const outcome: Outcome = {
    admitted: 0,
    noAvailability: 0,
    serializationConflict: 0,
    unexpected: [],
  }

  for (const result of results) {
    if (result.status === 'fulfilled') {
      outcome.admitted += 1
    } else if (result.reason instanceof NoAvailabilityError) {
      outcome.noAvailability += 1
    } else if (
      result.reason instanceof Prisma.PrismaClientKnownRequestError &&
      result.reason.code === TRANSACTION_CONFLICT
    ) {
      outcome.serializationConflict += 1
    } else {
      outcome.unexpected.push(result.reason)
    }
  }

  return outcome
}

describe('inventory overbooking (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let inventory: InventoryService

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    prisma = testApp.prisma
    inventory = app.get(InventoryService)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(prisma)
  })

  async function bookableFacility(
    onlineQuota: number,
  ): Promise<{ facilityId: string; userId: string }> {
    const operator = await seedOperator(prisma)
    const [facility, user] = await Promise.all([
      seedFacility(prisma, {
        operatorId: operator.id,
        lat: 37.9838,
        lng: 23.7275,
        onlineQuota,
        kind: FacilityKind.BUSINESS,
      }),
      seedUser(prisma),
    ])
    return { facilityId: facility.id, userId: user.id }
  }

  function hold(facilityId: string, userId: string, attempt: number) {
    return inventory.holdSlot({
      facilityId,
      userId,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      quotedPriceCents: 1_000,
      vehiclePlate: `E2E${attempt}`,
      vehicleType: 'CAR',
      accessCode: `CONCURRENT${attempt}`,
      tariffPlanId: 'plan-under-test',
      tariffPlanVersion: 1,
      sourceChannel: 'WEB',
      idempotencyKey: `idem-concurrent-${attempt}`,
    })
  }

  function race(facilityId: string, userId: string) {
    return Promise.allSettled(
      Array.from({ length: RACERS }, (_, attempt) => hold(facilityId, userId, attempt)),
    )
  }

  it('admits exactly one of 12 simultaneous holds when onlineQuota is 1', async () => {
    const { facilityId, userId } = await bookableFacility(1)

    const outcome = summarise(await race(facilityId, userId))

    expect(outcome.unexpected).toEqual([])
    expect(outcome.admitted).toBe(1)

    const persisted = await prisma.booking.findMany({ where: { facilityId } })
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.status).toBe(BookingStatus.PENDING_PAYMENT)
  })

  it('never admits more holds than the quota when 12 callers race for 3 slots', async () => {
    const { facilityId, userId } = await bookableFacility(3)

    const outcome = summarise(await race(facilityId, userId))

    expect(outcome.unexpected).toEqual([])
    expect(outcome.admitted).toBeGreaterThan(0)
    expect(outcome.admitted).toBeLessThanOrEqual(3)
    await expect(prisma.booking.count({ where: { facilityId } })).resolves.toBe(outcome.admitted)
  })

  /**
   * Liveness, the other half of the quota guarantee: contention must not cost sales.
   * Under Serializable the FOR UPDATE stamped the locked tuple and aborted every waiter
   * with 40001 the moment the winner committed, so exactly one hold was admitted no
   * matter how many slots were free.
   */
  it('fills all 3 free slots when 12 callers race for them', async () => {
    const { facilityId, userId } = await bookableFacility(3)

    const outcome = summarise(await race(facilityId, userId))

    expect(outcome.admitted).toBe(3)
  })

  /**
   * A caller that loses the race lost it on the quota, not on the isolation level, so it
   * gets the domain error that maps to 409 — not a raw abort that DomainExceptionFilter
   * would have to fall through to 500.
   */
  it('rejects losing racers with NoAvailabilityError, not a raw abort', async () => {
    const { facilityId, userId } = await bookableFacility(1)

    const outcome = summarise(await race(facilityId, userId))

    expect(outcome.serializationConflict).toBe(0)
    expect(outcome.noAvailability).toBe(RACERS - 1)
  })

  it('counts an overlapping hold against the quota but ignores an expired one', async () => {
    const { facilityId, userId } = await bookableFacility(1)

    await hold(facilityId, userId, 0)
    await expect(hold(facilityId, userId, 1)).rejects.toBeInstanceOf(NoAvailabilityError)

    await prisma.booking.updateMany({
      where: { facilityId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    })

    await expect(hold(facilityId, userId, 2)).resolves.toMatchObject({
      bookingId: expect.any(String),
    })
  })

  it('refuses to hold a slot at a non-BUSINESS or unpublished facility', async () => {
    const restricted = await seedOperator(prisma)
    const inactive = await seedOperator(prisma)
    const user = await seedUser(prisma)

    const [restrictedFacility, inactiveFacility] = await Promise.all([
      seedFacility(prisma, {
        operatorId: restricted.id,
        lat: 37.98,
        lng: 23.72,
        onlineQuota: 5,
        kind: FacilityKind.RESTRICTED,
      }),
      seedFacility(prisma, {
        operatorId: inactive.id,
        lat: 37.98,
        lng: 23.72,
        onlineQuota: 5,
        isActive: false,
      }),
    ])

    await expect(hold(restrictedFacility.id, user.id, 0)).rejects.toBeInstanceOf(
      FacilityNotBookableError,
    )
    await expect(hold(inactiveFacility.id, user.id, 1)).rejects.toBeInstanceOf(
      FacilityNotBookableError,
    )
    await expect(prisma.booking.count()).resolves.toBe(0)
  })
})
