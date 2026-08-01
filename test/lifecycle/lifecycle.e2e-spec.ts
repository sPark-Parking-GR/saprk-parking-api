import { BookingStatus, LifecycleStatus, PrismaClient, UserRole, VehicleType } from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { ConfigService } from '@nestjs/config'
import { AnalyticsService } from '../../src/analytics/analytics.service'
import {
  FacilityHasActiveBookingsError,
  LifecycleRestoreConflictError,
} from '../../src/common/errors/domain.errors'
import { FacilitiesService } from '../../src/facilities/facilities.service'
import { LifecyclePurgeService } from '../../src/lifecycle/lifecycle-purge.service'
import { LifecycleService } from '../../src/lifecycle/lifecycle.service'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { authUser } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  seedBooking,
  seedFacility,
  seedOperator,
  seedOwnership,
  seedPayment,
  seedTariffPlan,
  seedUser,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'

const CENTRE = { lat: 37.9838, lng: 23.7275 }
const ACTOR = { id: 'lifecycle-admin', role: 'platform_admin' }
const PAST = new Date('2026-01-10T10:00:00.000Z')
const PAST_END = new Date('2026-01-10T12:00:00.000Z')
const FUTURE = new Date('2027-01-10T10:00:00.000Z')
const FUTURE_END = new Date('2027-01-10T12:00:00.000Z')

const EVERY_STATUS = { in: Object.values(LifecycleStatus) }

describe('resource lifecycle (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  // Unextended client: writes fixture states the extended client hides, and asserts what
  // is REALLY in the database rather than what the filtered view of it shows.
  let raw: PrismaClient
  let lifecycle: LifecycleService
  let purge: LifecyclePurgeService
  let facilities: FacilitiesService

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    prisma = testApp.prisma
    raw = new PrismaClient()
    await raw.$connect()
    // JobsModule (which wires LifecycleModule into the app) is stubbed out by the e2e
    // harness, so the services are built directly against the app's extended client —
    // the same wiring JobsModule performs in production.
    lifecycle = new LifecycleService(prisma, app.get(ConfigService))
    purge = new LifecyclePurgeService(prisma)
    facilities = app.get(FacilitiesService)
  })

  afterAll(async () => {
    await raw.$disconnect()
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(raw)
  })

  describe('default filtering across every affected model', () => {
    it('hides an archived facility from findMany, findUnique and count; opt-in still sees it', async () => {
      const opA = await seedOperator(raw)
      const opB = await seedOperator(raw)
      const visible = await seedFacility(raw, { operatorId: opA.id, ...CENTRE })
      const archived = await seedFacility(raw, { operatorId: opB.id, ...CENTRE })
      await raw.facility.update({
        where: { id: archived.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })

      expect((await prisma.facility.findMany()).map((f) => f.id)).toEqual([visible.id])
      expect(await prisma.facility.findUnique({ where: { id: archived.id } })).toBeNull()
      expect(await prisma.facility.count()).toBe(1)

      const optIn = await prisma.facility.findMany({ where: { lifecycleStatus: EVERY_STATUS } })
      expect(optIn.map((f) => f.id).sort()).toEqual([visible.id, archived.id].sort())
      expect(
        await prisma.facility.findUnique({
          where: { id: archived.id, lifecycleStatus: EVERY_STATUS },
        }),
      ).not.toBeNull()
    })

    it('hides an archived tariff plan, including from the operator-default lookup', async () => {
      const op = await seedOperator(raw)
      const archivedDefault = await seedTariffPlan(raw, { operatorId: op.id, isDefault: true })
      await raw.tariffPlan.update({
        where: { id: archivedDefault.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })

      expect(await prisma.tariffPlan.findMany()).toEqual([])
      expect(
        await prisma.tariffPlan.findFirst({
          where: { operatorId: op.id, isDefault: true, isActive: true },
        }),
      ).toBeNull()
      expect(await prisma.tariffPlan.count({ where: { lifecycleStatus: EVERY_STATUS } })).toBe(1)
    })

    it('hides an archived operator', async () => {
      const kept = await seedOperator(raw)
      const archived = await seedOperator(raw)
      await raw.parkingOperator.update({
        where: { id: archived.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })

      expect((await prisma.parkingOperator.findMany()).map((o) => o.id)).toEqual([kept.id])
      expect(await prisma.parkingOperator.findUnique({ where: { id: archived.id } })).toBeNull()
    })

    it('hides an archived user from id and email lookups, which is what locks them out', async () => {
      const kept = await seedUser(raw)
      const archived = await seedUser(raw)
      await raw.user.update({
        where: { id: archived.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })

      expect((await prisma.user.findMany()).map((u) => u.id)).toEqual([kept.id])
      expect(await prisma.user.findUnique({ where: { id: archived.id } })).toBeNull()
      expect(await prisma.user.findUnique({ where: { email: archived.email } })).toBeNull()
    })
  })

  describe('raw SQL passes through the extension exactly as documented', () => {
    it('$queryRaw on the extended client still returns archived rows — the documented gap', async () => {
      const op = await seedOperator(raw)
      const archived = await seedFacility(raw, { operatorId: op.id, ...CENTRE })
      await raw.facility.update({
        where: { id: archived.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })

      expect(await prisma.facility.count()).toBe(0)
      const viaRawSql = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Facility"`
      expect(viaRawSql.map((r) => r.id)).toEqual([archived.id])
    })

    it('public search excludes an archived facility through its own SQL predicate, even if still flagged published', async () => {
      const opA = await seedOperator(raw)
      const opB = await seedOperator(raw)
      const listed = await seedFacility(raw, { operatorId: opA.id, ...CENTRE, name: 'Listed' })
      const archived = await seedFacility(raw, { operatorId: opB.id, ...CENTRE, name: 'Ghost' })
      // Lifecycle flips WITHOUT clearing isActive/isVerified, isolating the lifecycle
      // term that PUBLIC_VISIBLE_SQL carries precisely because raw SQL is unfiltered.
      await raw.facility.update({
        where: { id: archived.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })

      const result = await facilities.search({
        lat: CENTRE.lat,
        lng: CENTRE.lng,
        radiusMeters: 1_000,
        startsAt: FUTURE,
        endsAt: FUTURE_END,
      })

      expect(result.total).toBe(1)
      expect(result.points.map((p) => p.id)).toEqual([listed.id])
    })

    it('analytics still attributes revenue to an archived facility — intentional, asserted, not assumed', async () => {
      const operator = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
      await seedOwnership(raw, {
        facilityId: facility.id,
        operatorId: operator.id,
        from: new Date('2026-01-01T00:00:00.000Z'),
      })
      const consumer = await seedUser(raw)
      const booking = await seedBooking(raw, {
        facilityId: facility.id,
        userId: consumer.id,
        startsAt: PAST,
        endsAt: PAST_END,
        status: BookingStatus.CHECKED_OUT,
      })
      await seedPayment(raw, {
        bookingId: booking.id,
        amountCents: 5_000,
        createdAt: new Date('2026-01-10T12:30:00.000Z'),
      })
      await raw.facility.update({
        where: { id: facility.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED, isActive: false },
      })
      const admin = await seedUser(raw, { role: UserRole.PLATFORM_ADMIN })

      const analytics = app.get(AnalyticsService)
      const summary = await analytics.summary(authUser(admin), {
        from: new Date('2026-01-01T00:00:00.000Z'),
        to: new Date('2026-02-01T00:00:00.000Z'),
      })

      expect(summary.grossRevenueCents).toBe(5_000)
      expect(summary.bookingCount).toBe(1)
    })
  })

  describe('archive and restore semantics', () => {
    it('archiving a facility forces unpublish; restoring never republishes', async () => {
      const op = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: op.id, ...CENTRE, isActive: true })

      await lifecycle.archiveFacility(ACTOR, facility.id, 'seasonal closure')

      const archived = await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })
      expect(archived.lifecycleStatus).toBe(LifecycleStatus.ARCHIVED)
      expect(archived.isActive).toBe(false)
      expect(archived.lifecycleChangedBy).toBe(ACTOR.id)
      expect(archived.lifecycleReason).toBe('seasonal closure')

      await lifecycle.restoreFacility(ACTOR, facility.id)

      const restored = await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })
      expect(restored.lifecycleStatus).toBe(LifecycleStatus.ACTIVE)
      expect(restored.isActive).toBe(false)
    })

    it('refuses to archive a facility that still owes customers a parking place', async () => {
      const op = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: op.id, ...CENTRE })
      const consumer = await seedUser(raw)
      await seedBooking(raw, {
        facilityId: facility.id,
        userId: consumer.id,
        startsAt: FUTURE,
        endsAt: FUTURE_END,
        status: BookingStatus.CONFIRMED,
      })

      await expect(lifecycle.archiveFacility(ACTOR, facility.id)).rejects.toBeInstanceOf(
        FacilityHasActiveBookingsError,
      )
      const untouched = await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })
      expect(untouched.lifecycleStatus).toBe(LifecycleStatus.ACTIVE)
    })

    it('refuses to restore a facility when the operator filled the cap meanwhile, naming the conflict', async () => {
      const op = await seedOperator(raw)
      const original = await seedFacility(raw, { operatorId: op.id, ...CENTRE })
      await lifecycle.archiveFacility(ACTOR, original.id)
      const replacement = await seedFacility(raw, { operatorId: op.id, ...CENTRE })

      await expect(lifecycle.restoreFacility(ACTOR, original.id)).rejects.toThrow(
        new RegExp(replacement.id),
      )
      await expect(lifecycle.restoreFacility(ACTOR, original.id)).rejects.toBeInstanceOf(
        LifecycleRestoreConflictError,
      )

      const still = await raw.facility.findUniqueOrThrow({ where: { id: original.id } })
      expect(still.lifecycleStatus).toBe(LifecycleStatus.ARCHIVED)
    })

    it('refuses to restore an archived default plan once another plan holds the default slot', async () => {
      const op = await seedOperator(raw)
      const original = await seedTariffPlan(raw, { operatorId: op.id, isDefault: true })
      await lifecycle.archiveTariffPlan(ACTOR, original.id)

      // Archive preserved the flags, freeing the partial-index slot for a successor.
      const archived = await raw.tariffPlan.findUniqueOrThrow({ where: { id: original.id } })
      expect(archived.isDefault).toBe(true)
      expect(archived.isActive).toBe(true)

      const successor = await seedTariffPlan(raw, { operatorId: op.id, isDefault: true })

      await expect(lifecycle.restoreTariffPlan(ACTOR, original.id)).rejects.toThrow(
        new RegExp(successor.id),
      )
      await expect(lifecycle.restoreTariffPlan(ACTOR, original.id)).rejects.toBeInstanceOf(
        LifecycleRestoreConflictError,
      )
    })

    it('both recreated partial unique indexes carry the lifecycle predicate', async () => {
      const rows = await raw.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE indexname IN ('Facility_operatorId_claimed_key', 'TariffPlan_operator_active_default_key')`

      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row.indexdef).toContain('lifecycleStatus')
        expect(row.indexdef).toContain('ACTIVE')
      }
    })
  })

  describe('purge worker', () => {
    async function tombstone(
      table: 'facility' | 'tariffPlan' | 'parkingOperator' | 'user',
      id: string,
      purgeAfter = new Date(Date.now() - 1_000),
    ): Promise<void> {
      const data = { lifecycleStatus: LifecycleStatus.TOMBSTONED, purgeAfter }
      if (table === 'facility') await raw.facility.update({ where: { id }, data })
      if (table === 'tariffPlan') await raw.tariffPlan.update({ where: { id }, data })
      if (table === 'parkingOperator') await raw.parkingOperator.update({ where: { id }, data })
      if (table === 'user') await raw.user.update({ where: { id }, data })
    }

    it('skips a facility pinned by RESTRICT bookings and purges one that is free', async () => {
      const opA = await seedOperator(raw)
      const opB = await seedOperator(raw)
      const pinned = await seedFacility(raw, { operatorId: opA.id, ...CENTRE })
      const free = await seedFacility(raw, { operatorId: opB.id, ...CENTRE })
      const consumer = await seedUser(raw)
      await seedBooking(raw, {
        facilityId: pinned.id,
        userId: consumer.id,
        startsAt: PAST,
        endsAt: PAST_END,
        status: BookingStatus.CHECKED_OUT,
      })
      await tombstone('facility', pinned.id)
      await tombstone('facility', free.id)

      const summary = await purge.purgeDue()

      expect(summary.facilities).toEqual({ purged: 1, blocked: 1 })
      expect(await raw.facility.findUnique({ where: { id: pinned.id } })).not.toBeNull()
      expect(await raw.facility.findUnique({ where: { id: free.id } })).toBeNull()
    })

    it('purges a tombstoned tariff plan outright', async () => {
      const op = await seedOperator(raw)
      const plan = await seedTariffPlan(raw, { operatorId: op.id })
      await tombstone('tariffPlan', plan.id)

      const summary = await purge.purgeDue()

      expect(summary.tariffPlans).toEqual({ purged: 1, blocked: 0 })
      expect(await raw.tariffPlan.findUnique({ where: { id: plan.id } })).toBeNull()
    })

    it('skips an operator still referenced by a facility in ANY lifecycle state, purges a bare one', async () => {
      const referenced = await seedOperator(raw)
      const bare = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: referenced.id, ...CENTRE })
      const consumer = await seedUser(raw)
      await seedBooking(raw, {
        facilityId: facility.id,
        userId: consumer.id,
        startsAt: PAST,
        endsAt: PAST_END,
        status: BookingStatus.CHECKED_OUT,
      })
      await tombstone('facility', facility.id)
      await tombstone('parkingOperator', referenced.id)
      await tombstone('parkingOperator', bare.id)

      const summary = await purge.purgeDue()

      expect(summary.operators).toEqual({ purged: 1, blocked: 1 })
      expect(await raw.parkingOperator.findUnique({ where: { id: referenced.id } })).not.toBeNull()
      expect(await raw.parkingOperator.findUnique({ where: { id: bare.id } })).toBeNull()
    })

    it('anonymises a purged user in place: identity gone, financial history intact', async () => {
      const op = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: op.id, ...CENTRE })
      const user = await seedUser(raw)
      await raw.vehicle.create({
        data: { userId: user.id, plate: 'E2E-1234', type: VehicleType.CAR },
      })
      await seedBooking(raw, {
        facilityId: facility.id,
        userId: user.id,
        startsAt: PAST,
        endsAt: PAST_END,
        status: BookingStatus.CHECKED_OUT,
      })
      await tombstone('user', user.id)

      const summary = await purge.purgeDue()

      expect(summary.users).toEqual({ purged: 1, blocked: 0 })
      const anonymised = await raw.user.findUniqueOrThrow({ where: { id: user.id } })
      expect(anonymised.email).toBe(`deleted+${user.id}@deleted.invalid`)
      expect(anonymised.displayName).toBeNull()
      expect(anonymised.passwordHash).toBeNull()
      expect(anonymised.deletedAt).not.toBeNull()
      expect(anonymised.lifecycleStatus).toBe(LifecycleStatus.PURGED)
      expect(await raw.vehicle.count({ where: { userId: user.id } })).toBe(0)
      expect(await raw.booking.count({ where: { userId: user.id } })).toBe(1)
    })

    it('skips a user with unsettled bookings', async () => {
      const op = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: op.id, ...CENTRE })
      const user = await seedUser(raw)
      await seedBooking(raw, {
        facilityId: facility.id,
        userId: user.id,
        startsAt: FUTURE,
        endsAt: FUTURE_END,
        status: BookingStatus.CONFIRMED,
      })
      await tombstone('user', user.id)

      const summary = await purge.purgeDue()

      expect(summary.users).toEqual({ purged: 0, blocked: 1 })
      const untouched = await raw.user.findUniqueOrThrow({ where: { id: user.id } })
      expect(untouched.email).toBe(user.email)
      expect(untouched.lifecycleStatus).toBe(LifecycleStatus.TOMBSTONED)
    })

    it('leaves tombstones inside the retention window untouched', async () => {
      const op = await seedOperator(raw)
      const plan = await seedTariffPlan(raw, { operatorId: op.id })
      await tombstone('tariffPlan', plan.id, new Date(Date.now() + 86_400_000))

      const summary = await purge.purgeDue()

      expect(summary.tariffPlans).toEqual({ purged: 0, blocked: 0 })
      expect(await raw.tariffPlan.findUnique({ where: { id: plan.id } })).not.toBeNull()
    })

    it('is idempotent across repeated runs', async () => {
      const opA = await seedOperator(raw)
      const opB = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: opA.id, ...CENTRE })
      const plan = await seedTariffPlan(raw, { operatorId: opA.id })
      const user = await seedUser(raw)
      await tombstone('facility', facility.id)
      await tombstone('tariffPlan', plan.id)
      await tombstone('parkingOperator', opB.id)
      await tombstone('user', user.id)

      const first = await purge.purgeDue()
      expect(first.facilities.purged + first.tariffPlans.purged).toBe(2)
      expect(first.operators.purged).toBe(1)
      expect(first.users.purged).toBe(1)

      const second = await purge.purgeDue()
      expect(second).toEqual({
        facilities: { purged: 0, blocked: 0 },
        tariffPlans: { purged: 0, blocked: 0 },
        operators: { purged: 0, blocked: 0 },
        users: { purged: 0, blocked: 0 },
      })

      const purgedUser = await raw.user.findUniqueOrThrow({ where: { id: user.id } })
      expect(purgedUser.lifecycleStatus).toBe(LifecycleStatus.PURGED)
    })
  })
})
