import { PrismaClient, UserRole, type ParkingOperator } from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { FacilitiesService } from '../../src/facilities/facilities.service'
import { NotificationsService } from '../../src/notifications/notifications.service'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { QUOTA_THRESHOLD_WARNED_ACTION } from '../../src/subscriptions/quota-threshold.service'
import { authUser } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  seedOperator,
  seedOperatorSubscription,
  seedSubscriptionPlan,
  seedUser,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'

const CENTRE = { lat: 37.9838, lng: 23.7275 }

/**
 * The dedup is an audit-row existence check, which is exactly the kind of claim a mocked
 * Prisma cannot settle: it depends on a real row being visible to the next create's read,
 * on the JSON path filter matching what was written, and on the whole thing running after
 * the create's transaction has committed. So this drives the real service against the real
 * database and counts what came out.
 *
 * The service is driven directly rather than over HTTP for the same reason
 * facility-quota.e2e-spec.ts does: the create route is throttled, and this suite is about
 * the write path, not the rate limiter.
 */
describe('operator quota threshold nudges (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let raw: PrismaClient
  let facilities: FacilitiesService
  let sendNudge: jest.SpyInstance

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    prisma = testApp.prisma
    facilities = app.get(FacilitiesService)
    raw = new PrismaClient()
    await raw.$connect()
  })

  afterAll(async () => {
    sendNudge.mockRestore()
    await raw.$disconnect()
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(prisma)
    sendNudge = jest
      .spyOn(app.get(NotificationsService), 'sendOperatorQuotaThreshold')
      .mockResolvedValue(true)
  })

  afterEach(() => {
    sendNudge.mockRestore()
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

    const plan = await seedSubscriptionPlan(raw, {
      id: `plan_cap${maxFacilities}`,
      code: `cap${maxFacilities}`,
      name: `Cap ${maxFacilities}`,
      maxFacilities,
    })
    await seedOperatorSubscription(raw, { operatorId: operator.id, planId: plan.id })

    return { operator, actor: authUser(admin) }
  }

  function create(actor: ReturnType<typeof authUser>, operatorId: string, attempt: number) {
    return facilities.create(actor, {
      name: `Site ${attempt}`,
      address: `${attempt} Quota Street`,
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

  function warnings() {
    return raw.auditLog.findMany({
      where: {
        action: QUOTA_THRESHOLD_WARNED_ACTION,
        payload: { path: ['resource'], equals: 'facilities' },
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  it('nudges once when a create crosses 80% and never again at the same percentage', async () => {
    // Five slots, so the fourth create lands on exactly 80% and the fifth would move on.
    const { operator, actor } = await tenant(5)
    for (let i = 0; i < 3; i += 1) await create(actor, operator.id, i)

    expect(sendNudge).not.toHaveBeenCalled()
    await expect(warnings()).resolves.toHaveLength(0)

    await create(actor, operator.id, 3)

    expect(sendNudge).toHaveBeenCalledTimes(1)
    expect(sendNudge).toHaveBeenCalledWith(
      expect.objectContaining({ resourceLabel: 'facilities', threshold: 80, current: 4, limit: 5 }),
    )

    const recorded = await warnings()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.payload).toMatchObject({ resource: 'facilities', threshold: 80 })
    expect(recorded[0]!.entityType).toBe('OperatorSubscription')
  })

  it('does not duplicate the 80% nudge when a later create sits at the same threshold', async () => {
    // Ten slots: the eighth crosses 80%, the ninth is still 90% — over the line, same
    // threshold, and the customer must not hear about it twice.
    const { operator, actor } = await tenant(10)
    for (let i = 0; i < 8; i += 1) await create(actor, operator.id, i)

    expect(sendNudge).toHaveBeenCalledTimes(1)

    await create(actor, operator.id, 8)

    expect(sendNudge).toHaveBeenCalledTimes(1)
    await expect(warnings()).resolves.toHaveLength(1)
  })

  it('escalates to the 100% nudge exactly once when the last slot is taken', async () => {
    const { operator, actor } = await tenant(10)
    for (let i = 0; i < 10; i += 1) await create(actor, operator.id, i)

    const thresholds = sendNudge.mock.calls.map(
      (call) => (call[0] as { threshold: number }).threshold,
    )
    expect(thresholds).toEqual([80, 100])

    const recorded = await warnings()
    expect(recorded.map((row) => (row.payload as { threshold: number }).threshold)).toEqual([
      80, 100,
    ])
  })

  // The whole point of the audit-row dedup: a plan change is a new subscription id, and the
  // customer should hear about their new limits rather than inherit the old plan's silence.
  it('re-arms the nudge after the operator moves onto another plan', async () => {
    const { operator, actor } = await tenant(5)
    for (let i = 0; i < 4; i += 1) await create(actor, operator.id, i)
    expect(sendNudge).toHaveBeenCalledTimes(1)

    await raw.operatorSubscription.deleteMany({ where: { operatorId: operator.id } })
    const bigger = await seedSubscriptionPlan(raw, {
      id: 'plan_cap6',
      code: 'cap6',
      name: 'Cap 6',
      maxFacilities: 6,
    })
    await seedOperatorSubscription(raw, { operatorId: operator.id, planId: bigger.id })

    await create(actor, operator.id, 4)

    expect(sendNudge).toHaveBeenCalledTimes(2)
    expect(sendNudge).toHaveBeenLastCalledWith(
      expect.objectContaining({ threshold: 80, current: 5, limit: 6 }),
    )
  })

  // A nudge is a side effect, not a promise: the create the customer paid for stands even
  // when the mail provider is down.
  it('completes the create when the notification channel throws', async () => {
    const { operator, actor } = await tenant(5)
    for (let i = 0; i < 3; i += 1) await create(actor, operator.id, i)
    sendNudge.mockRejectedValue(new Error('smtp down'))

    await expect(create(actor, operator.id, 3)).resolves.toBeDefined()
    await expect(raw.facility.count({ where: { operatorId: operator.id } })).resolves.toBe(4)
  })
})
