import { PrismaClient, UserRole, type ParkingOperator } from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { EntitlementLimitExceededError } from '../../src/common/errors/domain.errors'
import { FacilitiesService } from '../../src/facilities/facilities.service'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { authUser } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  seedOperator,
  seedOperatorSubscription,
  seedSubscriptionPlan,
  seedUser,
  STARTER_PLAN_ID,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'

const CENTRE = { lat: 37.9838, lng: 23.7275 }
const RACERS = 8

interface Outcome {
  admitted: number
  refused: number
  unexpected: string[]
}

/**
 * The overbooking problem in a different costume, and the reason it needs a real database:
 * `Facility_operatorId_claimed_key` used to be the backstop that rejected the loser of a
 * check-then-act race with P2002. 20260803100000 dropped it — a unique index cannot express
 * "at most N" — so the `SELECT ... FOR UPDATE` on the ParkingOperator row that
 * FacilitiesService.create takes before the quota check is now the ONLY thing standing
 * between two simultaneous creates and both passing a quota of one.
 *
 * The service is driven directly rather than over HTTP so the concurrency under test is the
 * transaction's, not the throttler's — the create route is rate-limited to 30/min and a
 * burst of parallel requests would measure that instead.
 */
describe('facility quota under concurrency (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let raw: PrismaClient
  let facilities: FacilitiesService

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    prisma = testApp.prisma
    facilities = app.get(FacilitiesService)
    raw = new PrismaClient()
    await raw.$connect()
  })

  afterAll(async () => {
    await raw.$disconnect()
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(prisma)
  })

  async function tenant(maxFacilities: number): Promise<{
    operator: ParkingOperator
    actor: ReturnType<typeof authUser>
  }> {
    const operator = await seedOperator(prisma)
    const admin = await seedUser(prisma, {
      role: UserRole.OPERATOR_ADMIN,
      operatorId: operator.id,
    })

    if (maxFacilities === 1) {
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: STARTER_PLAN_ID })
    } else {
      const plan = await seedSubscriptionPlan(raw, {
        id: `plan_${maxFacilities}`,
        code: `cap${maxFacilities}`,
        name: `Cap ${maxFacilities}`,
        maxFacilities,
      })
      await seedOperatorSubscription(raw, { operatorId: operator.id, planId: plan.id })
    }

    return { operator, actor: authUser(admin) }
  }

  function create(actor: ReturnType<typeof authUser>, operatorId: string, attempt: number) {
    return facilities.create(actor, {
      name: `Racer ${attempt}`,
      address: `${attempt} Race Street`,
      lat: CENTRE.lat,
      lng: CENTRE.lng,
      totalCapacity: 50,
      onlineQuota: 10,
      vehicleTypes: ['car'],
      openingHours: { is24h: true },
      amenities: [],
      cancellationPolicy: '',
      operatorId,
    })
  }

  function race(actor: ReturnType<typeof authUser>, operatorId: string) {
    return Promise.allSettled(
      Array.from({ length: RACERS }, (_, attempt) => create(actor, operatorId, attempt)),
    )
  }

  /**
   * A rejection is only "expected" if it is the quota refusal. Anything else — a raw P2002,
   * a serialization abort surfacing unmapped, an internal error — is reported verbatim
   * rather than counted as a pass, so the test cannot succeed for the wrong reason.
   */
  function summarise(results: PromiseSettledResult<unknown>[]): Outcome {
    const outcome: Outcome = { admitted: 0, refused: 0, unexpected: [] }

    for (const result of results) {
      if (result.status === 'fulfilled') {
        outcome.admitted += 1
      } else if (result.reason instanceof EntitlementLimitExceededError) {
        outcome.refused += 1
      } else {
        outcome.unexpected.push(
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        )
      }
    }

    return outcome
  }

  it('admits exactly one of 8 simultaneous creates when the plan allows one facility', async () => {
    const { operator, actor } = await tenant(1)

    const outcome = summarise(await race(actor, operator.id))

    expect(outcome.unexpected).toEqual([])
    expect(outcome.admitted).toBe(1)
    expect(outcome.refused).toBe(RACERS - 1)

    const persisted = await raw.facility.findMany({ where: { operatorId: operator.id } })
    expect(persisted).toHaveLength(1)
  })

  it('never admits more than the plan allows when 8 callers race for 3 slots', async () => {
    const { operator, actor } = await tenant(3)

    const outcome = summarise(await race(actor, operator.id))

    expect(outcome.unexpected).toEqual([])
    expect(outcome.admitted).toBe(3)
    await expect(raw.facility.count({ where: { operatorId: operator.id } })).resolves.toBe(3)
  })

  // Liveness: contention must not cost sales. Every racer has to resolve one way or the
  // other, and the ones that lose must lose with the quota error rather than a deadlock.
  it('fills the quota exactly rather than losing slots to contention', async () => {
    const { operator, actor } = await tenant(5)

    const outcome = summarise(await race(actor, operator.id))

    expect(outcome.unexpected).toEqual([])
    expect(outcome.admitted + outcome.refused).toBe(RACERS)
    expect(outcome.admitted).toBe(5)
  })

  // Each facility create also writes a FacilityOwnershipPeriod in the same transaction.
  // A racer that was refused must leave neither row behind.
  it('leaves no orphaned ownership period from a refused racer', async () => {
    const { operator, actor } = await tenant(1)

    await race(actor, operator.id)

    const periods = await raw.facilityOwnershipPeriod.findMany({
      where: { operatorId: operator.id },
    })
    expect(periods).toHaveLength(1)
  })

  it('serializes concurrent creates for different operators independently', async () => {
    const [first, second] = await Promise.all([tenant(1), tenant(1)])

    const [a, b] = await Promise.all([
      race(first.actor, first.operator.id),
      race(second.actor, second.operator.id),
    ])

    expect(summarise(a).admitted).toBe(1)
    expect(summarise(b).admitted).toBe(1)
  })
})
