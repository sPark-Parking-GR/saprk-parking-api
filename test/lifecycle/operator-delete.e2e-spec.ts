import {
  BookingStatus,
  LifecycleStatus,
  PrismaClient,
  UserRole,
  VehicleType,
  type Facility,
  type ParkingOperator,
  type User,
} from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import request from 'supertest'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  seedBooking,
  seedFacility,
  seedFacilityManager,
  seedOperator,
  seedTariffPlan,
  seedTariffPlanManager,
  seedUser,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'
const LIFECYCLE = `${API}/admin/lifecycle`
const CENTRE = { lat: 37.9838, lng: 23.7275 }
const FUTURE = new Date('2027-01-10T10:00:00.000Z')
const FUTURE_END = new Date('2027-01-10T12:00:00.000Z')

interface TrashItem {
  resourceType: string
  id: string
  name: string
  status: LifecycleStatus
  reason: string | null
}

/**
 * What an operator calls "delete" must put the row in the platform administrator's bin,
 * not merely unpublish it. These assertions are deliberately end-to-end on both sides of
 * that contract: the operator can no longer see what they deleted, and the administrator
 * can — and can put it back.
 */
describe('operator delete archives into the admin trash (e2e)', () => {
  let app: NestFastifyApplication
  // Unextended client: the archived states under test are exactly what the extended
  // client hides, so fixtures and assertions both need the unfiltered view.
  let raw: PrismaClient

  let operator: ParkingOperator
  let operatorAdmin: User
  let operatorToken: string
  let platformToken: string

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    raw = new PrismaClient()
    await raw.$connect()
  })

  afterAll(async () => {
    await raw.$disconnect()
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(raw)
    resetThrottle(app)

    operator = await seedOperator(raw)
    operatorAdmin = await seedUser(raw, {
      role: UserRole.OPERATOR_ADMIN,
      operatorId: operator.id,
    })
    const platformAdmin = await seedUser(raw, { role: UserRole.PLATFORM_ADMIN })
    operatorToken = bearerToken(operatorAdmin)
    platformToken = bearerToken(platformAdmin)
  })

  function authed(method: 'get' | 'post' | 'delete' | 'patch', path: string, token: string) {
    return request(app.getHttpServer())[method](path).set('authorization', `Bearer ${token}`)
  }

  async function trash(): Promise<TrashItem[]> {
    const res = await authed('get', `${LIFECYCLE}/trash`, platformToken).expect(200)
    return (res.body as { items: TrashItem[] }).items
  }

  async function auditActions(entityId: string): Promise<string[]> {
    const rows = await raw.auditLog.findMany({ where: { entityId }, select: { action: true } })
    return rows.map((r) => r.action).sort()
  }

  describe('facility', () => {
    let facility: Facility

    beforeEach(async () => {
      facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE, name: 'Lot A' })
      // Seeded through Prisma, so the auto-assign the create endpoint would have done has
      // to be done by hand — otherwise the operator admin cannot reach their own facility.
      await seedFacilityManager(raw, { facilityId: facility.id, userId: operatorAdmin.id })
    })

    it('DELETE archives the facility and unpublishes it', async () => {
      await authed('delete', `${API}/facilities/${facility.id}`, operatorToken).expect(204)

      const row = await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })
      expect(row.lifecycleStatus).toBe(LifecycleStatus.ARCHIVED)
      expect(row.isActive).toBe(false)
      expect(row.lifecycleChangedBy).toBe(operatorAdmin.id)
      expect(row.lifecycleReason).toBe('Deleted by operator')
    })

    it('the owning operator can no longer see or open what it deleted', async () => {
      await authed('delete', `${API}/facilities/${facility.id}`, operatorToken).expect(204)

      const list = await authed('get', `${API}/facilities`, operatorToken).expect(200)
      expect((list.body as { items: unknown[]; total: number }).items).toEqual([])
      expect((list.body as { total: number }).total).toBe(0)

      await authed('get', `${API}/facilities/${facility.id}/manage`, operatorToken).expect(404)
    })

    it('the platform admin finds it in the trash and can restore it', async () => {
      await authed('delete', `${API}/facilities/${facility.id}`, operatorToken).expect(204)

      expect(await trash()).toEqual([
        expect.objectContaining({
          resourceType: 'facility',
          id: facility.id,
          name: 'Lot A',
          status: LifecycleStatus.ARCHIVED,
          reason: 'Deleted by operator',
        }),
      ])

      await authed('post', `${LIFECYCLE}/facility/${facility.id}/restore`, platformToken)
        .send({})
        .expect(204)

      expect(await trash()).toEqual([])
      await authed('get', `${API}/facilities/${facility.id}/manage`, operatorToken).expect(200)
      expect(
        (await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })).lifecycleStatus,
      ).toBe(LifecycleStatus.ACTIVE)
    })

    // One audit action per event: the lifecycle's own. The former facility.deactivated
    // row would have described the same delete twice.
    it('audits exactly one action, facility.archived', async () => {
      await authed('delete', `${API}/facilities/${facility.id}`, operatorToken).expect(204)

      expect(await auditActions(facility.id)).toEqual(['facility.archived'])
    })

    it('refuses while bookings are still to be honoured, leaving the facility ACTIVE', async () => {
      const consumer = await seedUser(raw)
      await seedBooking(raw, {
        facilityId: facility.id,
        userId: consumer.id,
        startsAt: FUTURE,
        endsAt: FUTURE_END,
        status: BookingStatus.CONFIRMED,
      })

      await authed('delete', `${API}/facilities/${facility.id}`, operatorToken).expect(409)

      const row = await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })
      expect(row.lifecycleStatus).toBe(LifecycleStatus.ACTIVE)
      expect(await auditActions(facility.id)).toEqual([])
    })

    /**
     * The re-check LifecycleService runs inside its own transaction must not refuse the
     * caller that just emptied the facility — the whole point of forcing. Cancellation
     * moves each booking out of CONFIRMED/CHECKED_IN, so by the time the archive counts
     * again there is nothing left to find.
     */
    it('force cancels the bookings and still archives, naming the refunds in the reason', async () => {
      const consumer = await seedUser(raw)
      const booking = await seedBooking(raw, {
        facilityId: facility.id,
        userId: consumer.id,
        startsAt: FUTURE,
        endsAt: FUTURE_END,
        status: BookingStatus.CONFIRMED,
      })

      await authed('delete', `${API}/facilities/${facility.id}?force=true`, operatorToken).expect(
        204,
      )

      expect((await raw.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
        BookingStatus.CANCELLED,
      )
      const row = await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })
      expect(row.lifecycleStatus).toBe(LifecycleStatus.ARCHIVED)
      expect(row.lifecycleReason).toBe(
        'Deleted by operator (forced: 1 booking(s) cancelled and refunded)',
      )
    })

    it('bulk delete archives too, so the two paths cannot diverge', async () => {
      await authed('patch', `${API}/facilities/bulk`, operatorToken)
        .send({ action: 'delete', ids: [facility.id] })
        .expect(200)

      expect(
        (await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })).lifecycleStatus,
      ).toBe(LifecycleStatus.ARCHIVED)
      expect(await trash()).toHaveLength(1)
    })

    // 'disable' is an unpublish, not a delete: it must NOT sweep the row into the bin.
    it('bulk disable unpublishes without archiving', async () => {
      await authed('patch', `${API}/facilities/bulk`, operatorToken)
        .send({ action: 'disable', ids: [facility.id] })
        .expect(200)

      const row = await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })
      expect(row.lifecycleStatus).toBe(LifecycleStatus.ACTIVE)
      expect(row.isActive).toBe(false)
      expect(await trash()).toEqual([])
    })
  })

  describe('tariff plan', () => {
    let facility: Facility
    let planId: string

    beforeEach(async () => {
      facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
      const plan = await seedTariffPlan(raw, { operatorId: operator.id, name: 'Standard' })
      planId = plan.id
      await seedFacilityManager(raw, { facilityId: facility.id, userId: operatorAdmin.id })
      await seedTariffPlanManager(raw, { tariffPlanId: planId, userId: operatorAdmin.id })
      await raw.facilityTariffAssignment.create({
        data: { facilityId: facility.id, tariffPlanId: planId, vehicleType: VehicleType.CAR },
      })
    })

    /**
     * isActive and isDefault survive the delete on purpose: restoreTariffPlan re-validates
     * the operator's one-active-default rule against exactly those fields, and the partial
     * unique index behind it counts only lifecycle-ACTIVE rows.
     */
    it('DELETE archives the plan, unassigns it, and preserves isActive/isDefault', async () => {
      await authed('delete', `${API}/tariff-plans/${planId}`, operatorToken).expect(204)

      const row = await raw.tariffPlan.findUniqueOrThrow({ where: { id: planId } })
      expect(row.lifecycleStatus).toBe(LifecycleStatus.ARCHIVED)
      expect(row.isActive).toBe(true)
      expect(row.lifecycleChangedBy).toBe(operatorAdmin.id)
      expect(await raw.facilityTariffAssignment.count({ where: { tariffPlanId: planId } })).toBe(0)
    })

    it('the owning operator can no longer list or open what it deleted', async () => {
      await authed('delete', `${API}/tariff-plans/${planId}`, operatorToken).expect(204)

      const list = await authed('get', `${API}/tariff-plans`, operatorToken).expect(200)
      expect((list.body as { items: unknown[] }).items).toEqual([])

      await authed('get', `${API}/tariff-plans/${planId}`, operatorToken).expect(404)
    })

    it('the platform admin finds it in the trash and can restore it', async () => {
      await authed('delete', `${API}/tariff-plans/${planId}`, operatorToken).expect(204)

      expect(await trash()).toEqual([
        expect.objectContaining({
          resourceType: 'tariff-plan',
          id: planId,
          name: 'Standard',
          status: LifecycleStatus.ARCHIVED,
          reason: 'Deleted by operator',
        }),
      ])

      await authed('post', `${LIFECYCLE}/tariff-plan/${planId}/restore`, platformToken)
        .send({})
        .expect(204)

      expect(await trash()).toEqual([])
      const list = await authed('get', `${API}/tariff-plans`, operatorToken).expect(200)
      expect((list.body as { items: Array<{ id: string; isActive: boolean }> }).items).toEqual([
        expect.objectContaining({ id: planId, isActive: true }),
      ])
    })

    it('audits exactly one action, tariff_plan.archived', async () => {
      await authed('delete', `${API}/tariff-plans/${planId}`, operatorToken).expect(204)

      expect(await auditActions(planId)).toEqual(['tariff_plan.archived'])
    })
  })
})
