import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  LifecycleStatus,
  OperatorMemberRole,
  PrismaClient,
  UserRole,
  type Facility,
  type ParkingOperator,
  type TariffPlan,
  type User,
} from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import request from 'supertest'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  seedFacility,
  seedFacilityManager,
  seedOperator,
  seedOperatorSubscription,
  seedSubscriptionPlan,
  seedTariffPlan,
  seedTariffPlanManager,
  seedUnclaimedOperator,
  seedUser,
  UNCLAIMED_OPERATOR_ID,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'
const CENTRE = { lat: 37.9838, lng: 23.7275 }
const MAP_BOUNDS = { north: 38.2, south: 37.8, east: 24.0, west: 23.5 }
const MIGRATION = resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260804100000_resource_manager_assignment',
  'migration.sql',
)

let seq = 0

function facilityBody(over: Record<string, unknown> = {}) {
  seq += 1
  return {
    name: `Facility ${seq}`,
    address: `${seq} Test Street`,
    lat: CENTRE.lat,
    lng: CENTRE.lng,
    totalCapacity: 50,
    onlineQuota: 10,
    vehicleTypes: ['car'],
    openingHours: { is24h: true },
    amenities: [],
    cancellationPolicy: 'FLEXIBLE',
    ...over,
  }
}

function tariffDraft(over: Record<string, unknown> = {}) {
  seq += 1
  return {
    name: `Plan ${seq}`,
    isActive: true,
    isDefault: false,
    validFrom: null,
    validTo: null,
    timezone: 'Europe/Athens',
    graceMinutes: 0,
    incrementMinutes: 60,
    vehicleTypes: ['car'],
    tiers: [{ key: 't', fromMinute: 0, toMinute: null, unit: 'per_block', blockMinutes: 60 }],
    windows: [{ key: 'all', label: 'All', dayMask: 127, startMinute: 0, endMinute: 1440 }],
    rates: [{ tierKey: 't', windowKey: 'all', priceCents: 300, currency: 'EUR' }],
    caps: [],
    ...over,
  }
}

/**
 * The per-user management assignment over real Postgres. The unit specs prove the predicate
 * and the endpoint rules against mocks; this suite proves that the migration, the two join
 * tables, the Prisma predicate and the raw admin-map SQL all agree once a real database is
 * underneath them — and that the backfill really does preserve today's access.
 */
describe('resource manager assignment (e2e)', () => {
  let app: NestFastifyApplication
  let raw: PrismaClient

  let operator: ParkingOperator
  let other: ParkingOperator
  let admin: User
  let staff: User
  // A second ADMIN of the same operator. TariffController is @Roles('operator_admin',
  // 'platform_admin') at class level, so operator_staff cannot reach a tariff-plan route at
  // all — the plan narrowing is only observable between two admins of one tenant.
  let peer: User
  let otherAdmin: User
  let platform: User
  let adminToken: string
  let staffToken: string
  let peerToken: string
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
    ;[operator, other] = await Promise.all([
      seedOperator(raw, { name: 'Alpha' }),
      seedOperator(raw, { name: 'Beta' }),
    ])

    // The Starter plan caps facilities at one; several of these cases need more than that,
    // and the quota is not what is under test here.
    await seedSubscriptionPlan(raw, {
      id: 'plan_unlimited',
      code: 'unlimited',
      name: 'Unlimited',
      maxFacilities: null,
      maxTariffPlans: null,
    })
    await Promise.all([
      seedOperatorSubscription(raw, { operatorId: operator.id, planId: 'plan_unlimited' }),
      seedOperatorSubscription(raw, { operatorId: other.id, planId: 'plan_unlimited' }),
    ])
    ;[admin, staff, peer, otherAdmin, platform] = await Promise.all([
      seedUser(raw, { role: UserRole.OPERATOR_ADMIN, operatorId: operator.id }),
      seedUser(raw, {
        role: UserRole.OPERATOR_STAFF,
        operatorId: operator.id,
        memberRole: OperatorMemberRole.STAFF,
      }),
      seedUser(raw, { role: UserRole.OPERATOR_ADMIN, operatorId: operator.id }),
      seedUser(raw, { role: UserRole.OPERATOR_ADMIN, operatorId: other.id }),
      seedUser(raw, { role: UserRole.PLATFORM_ADMIN }),
    ])

    adminToken = bearerToken(admin)
    staffToken = bearerToken(staff)
    peerToken = bearerToken(peer)
    platformToken = bearerToken(platform)
  })

  function authed(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    token: string,
  ) {
    return request(app.getHttpServer())
      [method](`${API}${path}`)
      .set('authorization', `Bearer ${token}`)
  }

  async function twoFacilities(): Promise<[Facility, Facility]> {
    const [mine, theirs] = await Promise.all([
      seedFacility(raw, { operatorId: operator.id, ...CENTRE, name: 'Assigned' }),
      seedFacility(raw, { operatorId: operator.id, lat: 37.985, lng: 23.73, name: 'Unassigned' }),
    ])
    return [mine, theirs]
  }

  describe('visibility', () => {
    it('a staff member sees only the facilities assigned to them, not everything the operator owns', async () => {
      const [assigned] = await twoFacilities()
      await seedFacilityManager(raw, { facilityId: assigned.id, userId: staff.id })

      const res = await authed('get', '/facilities', staffToken).expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([assigned.id])
    })

    it('refuses to open an unassigned facility with the same not-found a foreign id gets', async () => {
      const [assigned, unassigned] = await twoFacilities()
      await seedFacilityManager(raw, { facilityId: assigned.id, userId: staff.id })
      const foreign = await seedFacility(raw, { operatorId: other.id, ...CENTRE })

      await authed('get', `/facilities/${assigned.id}/manage`, staffToken).expect(200)
      await authed('get', `/facilities/${unassigned.id}/manage`, staffToken).expect(404)
      await authed('get', `/facilities/${foreign.id}/manage`, staffToken).expect(404)
    })

    it('refuses to edit or delete an unassigned facility', async () => {
      const [, unassigned] = await twoFacilities()

      await authed('patch', `/facilities/${unassigned.id}`, adminToken)
        .send({ name: 'Renamed' })
        .expect(404)
      await authed('delete', `/facilities/${unassigned.id}`, adminToken).expect(404)
    })

    it('excludes unassigned facilities from a bulk action rather than erroring', async () => {
      const [assigned, unassigned] = await twoFacilities()
      await seedFacilityManager(raw, { facilityId: assigned.id, userId: admin.id })

      const res = await authed('patch', '/facilities/bulk', adminToken)
        .send({ ids: [assigned.id, unassigned.id], action: 'enable' })
        .expect(200)

      expect(res.body.affected).toBe(1)
      expect(
        (await raw.facility.findUniqueOrThrow({ where: { id: unassigned.id } })).isActive,
      ).toBe(true)
      expect((await raw.facility.findUniqueOrThrow({ where: { id: assigned.id } })).isActive).toBe(
        true,
      )
    })

    // The admin map renders its filters three times — a Prisma where for the points, raw
    // SQL for the count and raw SQL for the cluster buckets. If only one carried the
    // narrowing the total would contradict the list.
    it('narrows the admin map total and points identically to the list', async () => {
      const [assigned] = await twoFacilities()
      await seedFacilityManager(raw, { facilityId: assigned.id, userId: staff.id })
      const query = new URLSearchParams(
        Object.entries(MAP_BOUNDS).map<[string, string]>(([k, v]) => [k, String(v)]),
      )

      const res = await authed('get', `/facilities/map?${query.toString()}`, staffToken).expect(200)

      expect(res.body.total).toBe(1)
      expect(res.body.points.map((p: { id: string }) => p.id)).toEqual([assigned.id])
    })

    it('an operator admin sees only the tariff plans assigned to them', async () => {
      const [assigned, unassigned] = await Promise.all([
        seedTariffPlan(raw, { operatorId: operator.id, name: 'Assigned' }),
        seedTariffPlan(raw, { operatorId: operator.id, name: 'Unassigned' }),
      ])
      await seedTariffPlanManager(raw, { tariffPlanId: assigned.id, userId: admin.id })

      const list = await authed('get', '/tariff-plans', adminToken).expect(200)
      expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([assigned.id])

      await authed('get', `/tariff-plans/${assigned.id}`, adminToken).expect(200)
      await authed('get', `/tariff-plans/${unassigned.id}`, adminToken).expect(404)

      // Same operator, same role, no assignment: sees neither.
      expect((await authed('get', '/tariff-plans', peerToken).expect(200)).body.items).toEqual([])
    })

    it('refuses to update or delete an unassigned plan', async () => {
      const plan = await seedTariffPlan(raw, { operatorId: operator.id })

      await authed('patch', `/tariff-plans/${plan.id}`, adminToken).send(tariffDraft()).expect(404)
      await authed('delete', `/tariff-plans/${plan.id}`, adminToken).expect(404)
      await authed('get', `/tariff-plans/${plan.id}/assignments`, adminToken).expect(404)
    })

    // Promoting a replacement default rewrites the fallback price of every facility in the
    // operator, so the candidate is narrowed like any other plan the caller names.
    it('refuses to promote a replacement default the caller does not manage', async () => {
      const [mine, theirs, third] = await Promise.all([
        seedTariffPlan(raw, { operatorId: operator.id, name: 'Mine', isDefault: true }),
        seedTariffPlan(raw, { operatorId: operator.id, name: 'Theirs' }),
        seedTariffPlan(raw, { operatorId: operator.id, name: 'Third' }),
      ])
      await seedTariffPlanManager(raw, { tariffPlanId: mine.id, userId: admin.id })

      await authed(
        'delete',
        `/tariff-plans/${mine.id}?newDefaultPlanId=${theirs.id}`,
        adminToken,
      ).expect(404)

      expect((await raw.tariffPlan.findUniqueOrThrow({ where: { id: theirs.id } })).isDefault).toBe(
        false,
      )
      expect((await raw.tariffPlan.findUniqueOrThrow({ where: { id: mine.id } })).isDefault).toBe(
        true,
      )

      // Granted, the very same call goes through.
      await seedTariffPlanManager(raw, { tariffPlanId: theirs.id, userId: admin.id })
      await authed(
        'delete',
        `/tariff-plans/${mine.id}?newDefaultPlanId=${theirs.id}`,
        adminToken,
      ).expect(204)
      expect((await raw.tariffPlan.findUniqueOrThrow({ where: { id: theirs.id } })).isDefault).toBe(
        true,
      )
      expect(third.operatorId).toBe(operator.id)
    })

    it('never names a facility the caller cannot open through the plan assignments view', async () => {
      const [mine, hidden] = await twoFacilities()
      const plan = await seedTariffPlan(raw, { operatorId: operator.id })
      await Promise.all([
        seedTariffPlanManager(raw, { tariffPlanId: plan.id, userId: admin.id }),
        seedFacilityManager(raw, { facilityId: mine.id, userId: admin.id }),
        raw.facilityTariffAssignment.create({
          data: { facilityId: mine.id, tariffPlanId: plan.id, vehicleType: 'CAR' },
        }),
        raw.facilityTariffAssignment.create({
          data: { facilityId: hidden.id, tariffPlanId: plan.id, vehicleType: 'CAR' },
        }),
      ])

      const res = await authed('get', `/tariff-plans/${plan.id}/assignments`, adminToken).expect(
        200,
      )

      expect(res.body.facilities.map((f: { id: string }) => f.id)).toEqual([mine.id])
      expect(res.body.count).toBe(1)
      expect(JSON.stringify(res.body)).not.toContain(hidden.id)
    })

    it('refuses to attach a plan the caller does not manage to a facility they do', async () => {
      const [facility] = await twoFacilities()
      const plan = await seedTariffPlan(raw, { operatorId: operator.id })
      await seedFacilityManager(raw, { facilityId: facility.id, userId: admin.id })

      await authed('patch', `/facilities/${facility.id}/tariff-plan`, adminToken)
        .send({ vehicleType: 'CAR', tariffPlanId: plan.id })
        .expect(404)

      await seedTariffPlanManager(raw, { tariffPlanId: plan.id, userId: admin.id })
      await authed('patch', `/facilities/${facility.id}/tariff-plan`, adminToken)
        .send({ vehicleType: 'CAR', tariffPlanId: plan.id })
        .expect(200)
    })

    it('a platform admin sees everything, everywhere, with no assignment anywhere', async () => {
      const [a, b] = await twoFacilities()
      const foreign = await seedFacility(raw, { operatorId: other.id, ...CENTRE })
      await seedTariffPlan(raw, { operatorId: operator.id })

      const facilities = await authed('get', '/facilities', platformToken).expect(200)
      expect(facilities.body.total).toBe(3)
      expect(facilities.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
        [a.id, b.id, foreign.id].sort(),
      )

      const plans = await authed('get', '/tariff-plans', platformToken).expect(200)
      expect(plans.body.items).toHaveLength(1)

      expect(await raw.facilityManager.count()).toBe(0)
    })
  })

  describe('auto-assignment on create', () => {
    it('lets the creator immediately see and open the facility they created', async () => {
      const created = await authed('post', '/facilities', adminToken)
        .send(facilityBody())
        .expect(201)

      const id = created.body.id as string
      expect(await raw.facilityManager.findMany({ where: { facilityId: id } })).toEqual([
        expect.objectContaining({ facilityId: id, userId: admin.id, assignedBy: admin.id }),
      ])

      const list = await authed('get', '/facilities', adminToken).expect(200)
      expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([id])
      await authed('get', `/facilities/${id}/manage`, adminToken).expect(200)
    })

    it('does not make the creation visible to a colleague in the same operator', async () => {
      await authed('post', '/facilities', adminToken).send(facilityBody()).expect(201)

      const list = await authed('get', '/facilities', staffToken).expect(200)
      expect(list.body.total).toBe(0)
    })

    it('lets the creator immediately open the tariff plan they created', async () => {
      const created = await authed('post', '/tariff-plans', adminToken)
        .send(tariffDraft())
        .expect(201)

      const id = created.body.id as string
      expect(await raw.tariffPlanManager.count({ where: { tariffPlanId: id } })).toBe(1)
      await authed('get', `/tariff-plans/${id}`, adminToken).expect(200)
    })

    /**
     * A platform admin gets no row of their own — they already see everything — but the
     * resource must not land unmanaged either, or the tenant it was created FOR could not
     * see it and would need a second platform-admin action to be handed it.
     */
    it('seeds a platform-admin creation to the operator’s admins, not to the creator', async () => {
      const created = await authed('post', '/facilities', platformToken)
        .send(facilityBody({ operatorId: operator.id }))
        .expect(201)

      const id = created.body.id as string
      const rows = await raw.facilityManager.findMany({
        where: { facilityId: id },
        orderBy: { userId: 'asc' },
      })
      expect(rows.map((r) => r.userId).sort()).toEqual([admin.id, peer.id].sort())
      expect(rows.every((r) => r.assignedBy === platform.id)).toBe(true)

      await authed('get', `/facilities/${id}/manage`, adminToken).expect(200)
      // STAFF members are not seeded: an admin can delegate onward, a platform admin does
      // not decide for them who inside the tenant should hold it.
      await authed('get', `/facilities/${id}/manage`, staffToken).expect(404)
    })

    // An unclaimed ingestion tenant, or a shell operator whose invite is still outstanding:
    // there is nobody to hand it to, so it stays platform-admin-only until there is.
    it('leaves a platform-admin creation unmanaged when the operator has no members', async () => {
      const memberless = await seedOperator(raw, { name: 'Memberless' })

      const created = await authed('post', '/facilities', platformToken)
        .send(facilityBody({ operatorId: memberless.id }))
        .expect(201)

      expect(await raw.facilityManager.count({ where: { facilityId: created.body.id } })).toBe(0)
    })
  })

  describe('manager endpoints', () => {
    let facility: Facility
    let plan: TariffPlan

    beforeEach(async () => {
      facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
      plan = await seedTariffPlan(raw, { operatorId: operator.id })
    })

    it('returns the current managers and the assignable candidates in one call', async () => {
      await seedFacilityManager(raw, { facilityId: facility.id, userId: staff.id })

      const res = await authed('get', `/facilities/${facility.id}/managers`, adminToken).expect(200)

      expect(res.body.resourceId).toBe(facility.id)
      expect(res.body.operatorId).toBe(operator.id)
      expect(res.body.managers).toEqual([
        expect.objectContaining({
          userId: staff.id,
          email: staff.email,
          memberRole: OperatorMemberRole.STAFF,
          assignedBy: staff.id,
        }),
      ])
      expect(res.body.candidates.map((c: { userId: string }) => c.userId).sort()).toEqual(
        [admin.id, staff.id, peer.id].sort(),
      )
    })

    it('replaces the whole set idempotently and reports the new state', async () => {
      const first = await authed('put', `/facilities/${facility.id}/managers`, adminToken)
        .send({ userIds: [staff.id] })
        .expect(200)
      expect(first.body.managers.map((m: { userId: string }) => m.userId)).toEqual([staff.id])

      const again = await authed('put', `/facilities/${facility.id}/managers`, adminToken)
        .send({ userIds: [staff.id] })
        .expect(200)
      expect(again.body.managers.map((m: { userId: string }) => m.userId)).toEqual([staff.id])
      expect(await raw.facilityManager.count({ where: { facilityId: facility.id } })).toBe(1)
    })

    it('grants working access, and revokes it again on the next replace', async () => {
      await authed('put', `/facilities/${facility.id}/managers`, adminToken)
        .send({ userIds: [staff.id] })
        .expect(200)
      await authed('get', `/facilities/${facility.id}/manage`, staffToken).expect(200)

      await authed('put', `/facilities/${facility.id}/managers`, adminToken)
        .send({ userIds: [] })
        .expect(200)
      await authed('get', `/facilities/${facility.id}/manage`, staffToken).expect(404)
    })

    it('audits each change with the added and removed ids', async () => {
      await authed('put', `/facilities/${facility.id}/managers`, adminToken)
        .send({ userIds: [staff.id] })
        .expect(200)
      await authed('put', `/facilities/${facility.id}/managers`, adminToken)
        .send({ userIds: [admin.id] })
        .expect(200)

      const rows = await raw.auditLog.findMany({
        where: { entityId: facility.id, action: 'facility.managers_changed' },
        orderBy: { createdAt: 'asc' },
      })
      expect(rows).toHaveLength(2)
      expect(rows[0]!.payload).toEqual({ added: [staff.id], removed: [] })
      expect(rows[1]!.payload).toEqual({ added: [admin.id], removed: [staff.id] })
    })

    it('rejects a cross-tenant grant outright rather than dropping the id', async () => {
      const res = await authed('put', `/facilities/${facility.id}/managers`, adminToken)
        .send({ userIds: [staff.id, otherAdmin.id] })
        .expect(400)

      expect(res.body.message).toContain(otherAdmin.id)
      expect(await raw.facilityManager.count({ where: { facilityId: facility.id } })).toBe(0)
    })

    it('rejects a platform admin and a consumer account as assignees', async () => {
      const consumer = await seedUser(raw, {
        role: UserRole.USER,
        operatorId: operator.id,
        memberRole: OperatorMemberRole.STAFF,
      })
      await raw.operatorMembership.create({
        data: { operatorId: operator.id, userId: platform.id, role: OperatorMemberRole.STAFF },
      })

      await authed('put', `/facilities/${facility.id}/managers`, adminToken)
        .send({ userIds: [platform.id] })
        .expect(400)
      await authed('put', `/facilities/${facility.id}/managers`, adminToken)
        .send({ userIds: [consumer.id] })
        .expect(400)
      expect(await raw.facilityManager.count()).toBe(0)
    })

    it('does not leak the existence of another tenant’s resource', async () => {
      const foreign = await seedFacility(raw, { operatorId: other.id, ...CENTRE })
      const foreignPlan = await seedTariffPlan(raw, { operatorId: other.id })

      await authed('get', `/facilities/${foreign.id}/managers`, adminToken).expect(404)
      await authed('get', '/facilities/does-not-exist/managers', adminToken).expect(404)
      await authed('put', `/facilities/${foreign.id}/managers`, adminToken)
        .send({ userIds: [] })
        .expect(404)
      await authed('get', `/tariff-plans/${foreignPlan.id}/managers`, adminToken).expect(404)
    })

    it('refuses operator_staff on both the read and the write', async () => {
      await authed('get', `/facilities/${facility.id}/managers`, staffToken).expect(403)
      await authed('put', `/facilities/${facility.id}/managers`, staffToken)
        .send({ userIds: [staff.id] })
        .expect(403)
    })

    it('lets a platform admin assign inside any operator', async () => {
      await authed('put', `/facilities/${facility.id}/managers`, platformToken)
        .send({ userIds: [staff.id] })
        .expect(200)

      await authed('get', `/facilities/${facility.id}/manage`, staffToken).expect(200)
    })

    // The accepted trade-off, asserted so it stays a decision rather than a surprise.
    it('lets an operator admin grant themselves a resource nobody manages', async () => {
      await authed('get', `/facilities/${facility.id}/manage`, adminToken).expect(404)

      await authed('put', `/facilities/${facility.id}/managers`, adminToken)
        .send({ userIds: [admin.id] })
        .expect(200)

      await authed('get', `/facilities/${facility.id}/manage`, adminToken).expect(200)
    })

    it('manages tariff-plan assignments through the same shape', async () => {
      await authed('get', `/tariff-plans/${plan.id}`, peerToken).expect(404)

      const res = await authed('put', `/tariff-plans/${plan.id}/managers`, adminToken)
        .send({ userIds: [peer.id] })
        .expect(200)

      expect(res.body.resourceId).toBe(plan.id)
      expect(res.body.managers.map((m: { userId: string }) => m.userId)).toEqual([peer.id])
      await authed('get', `/tariff-plans/${plan.id}`, peerToken).expect(200)
    })

    it('rejects a body that is not a string array', async () => {
      await authed('put', `/facilities/${facility.id}/managers`, adminToken)
        .send({ userIds: 'nope' })
        .expect(400)
    })
  })

  describe('revocation', () => {
    it('removing a membership deletes that operator’s assignments and leaves others alone', async () => {
      const [mine] = await twoFacilities()
      const plan = await seedTariffPlan(raw, { operatorId: operator.id })
      const elsewhere = await seedFacility(raw, { operatorId: other.id, ...CENTRE })
      await raw.operatorMembership.create({
        data: { operatorId: other.id, userId: staff.id, role: OperatorMemberRole.STAFF },
      })
      await Promise.all([
        seedFacilityManager(raw, { facilityId: mine.id, userId: staff.id }),
        seedTariffPlanManager(raw, { tariffPlanId: plan.id, userId: staff.id }),
        seedFacilityManager(raw, { facilityId: elsewhere.id, userId: staff.id }),
      ])

      await authed('delete', `/operators/${operator.id}/members/${staff.id}`, adminToken).expect(
        204,
      )

      expect(await raw.facilityManager.findMany({ where: { userId: staff.id } })).toEqual([
        expect.objectContaining({ facilityId: elsewhere.id }),
      ])
      expect(await raw.tariffPlanManager.count({ where: { userId: staff.id } })).toBe(0)
    })

    it('a removed member can no longer reach what they managed', async () => {
      const [mine] = await twoFacilities()
      await seedFacilityManager(raw, { facilityId: mine.id, userId: staff.id })
      await authed('get', `/facilities/${mine.id}/manage`, staffToken).expect(200)

      await authed('delete', `/operators/${operator.id}/members/${staff.id}`, adminToken).expect(
        204,
      )

      // The session watermark moves on removal, so the old token is rejected outright —
      // and the assignment row is gone underneath it either way.
      await authed('get', `/facilities/${mine.id}/manage`, staffToken).expect(401)
      expect(await raw.facilityManager.count({ where: { userId: staff.id } })).toBe(0)
    })

    it('deleting the facility cascades its assignments away', async () => {
      const [mine] = await twoFacilities()
      await seedFacilityManager(raw, { facilityId: mine.id, userId: staff.id })

      await raw.facility.delete({ where: { id: mine.id } })

      expect(await raw.facilityManager.count()).toBe(0)
    })
  })

  describe('backfill migration', () => {
    it('is part of the applied chain', async () => {
      const rows = await raw.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM _prisma_migrations
        WHERE migration_name = '20260804100000_resource_manager_assignment'`

      expect(rows).toHaveLength(1)
    })

    /**
     * The chain already ran against an empty database in global setup, and truncateAll then
     * cleared the tables — so the only honest way to assert the backfill is to replay the
     * migration's OWN statements over pre-migration-shaped data. Reading them out of the
     * file rather than restating them here means a change to the SQL cannot pass this test
     * while breaking the deploy.
     */
    function backfillStatements(): string[] {
      const sql = readFileSync(MIGRATION, 'utf8')
      const statements = sql
        .slice(sql.indexOf('INSERT INTO "FacilityManager"'))
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('INSERT INTO'))

      expect(statements).toHaveLength(2)
      return statements
    }

    it('assigns every existing resource to every current member of its owning operator', async () => {
      const [a, b] = await twoFacilities()
      const plan = await seedTariffPlan(raw, { operatorId: operator.id })
      const foreign = await seedFacility(raw, { operatorId: other.id, ...CENTRE })
      await raw.facilityManager.deleteMany({})
      await raw.tariffPlanManager.deleteMany({})

      for (const statement of backfillStatements()) {
        await raw.$executeRawUnsafe(statement)
      }

      // Alpha's three members each get both Alpha facilities; Beta's admin gets only Beta's.
      const rows = await raw.facilityManager.findMany({
        select: { facilityId: true, userId: true, assignedBy: true },
      })
      expect(rows).toHaveLength(7)
      expect(rows.every((r) => r.assignedBy === 'system:backfill')).toBe(true)
      for (const member of [admin, staff, peer]) {
        expect(
          rows
            .filter((r) => r.userId === member.id)
            .map((r) => r.facilityId)
            .sort(),
        ).toEqual([a.id, b.id].sort())
      }
      expect(rows.filter((r) => r.userId === otherAdmin.id).map((r) => r.facilityId)).toEqual([
        foreign.id,
      ])

      const planRows = await raw.tariffPlanManager.findMany({
        select: { userId: true, tariffPlanId: true },
      })
      expect(planRows.map((r) => r.userId).sort()).toEqual([admin.id, staff.id, peer.id].sort())
      expect(planRows.every((r) => r.tariffPlanId === plan.id)).toBe(true)
    })

    it('leaves existing access unchanged: every member still sees what they saw before', async () => {
      const [a, b] = await twoFacilities()
      await raw.facilityManager.deleteMany({})

      for (const statement of backfillStatements()) {
        await raw.$executeRawUnsafe(statement)
      }

      const asAdmin = await authed('get', '/facilities', adminToken).expect(200)
      const asStaff = await authed('get', '/facilities', staffToken).expect(200)

      expect(asAdmin.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
        [a.id, b.id].sort(),
      )
      expect(asStaff.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
        [a.id, b.id].sort(),
      )
    })

    // The backfill must not mint a grant ResourceManagersService would itself refuse.
    it('skips members the manager endpoint would reject as assignees', async () => {
      const [facility] = await twoFacilities()
      const [consumer, archived, tombstoned] = await Promise.all([
        seedUser(raw, {
          role: UserRole.USER,
          operatorId: operator.id,
          memberRole: OperatorMemberRole.STAFF,
        }),
        seedUser(raw, {
          role: UserRole.OPERATOR_STAFF,
          operatorId: operator.id,
          memberRole: OperatorMemberRole.STAFF,
        }),
        seedUser(raw, {
          role: UserRole.OPERATOR_STAFF,
          operatorId: operator.id,
          memberRole: OperatorMemberRole.STAFF,
        }),
      ])
      await raw.operatorMembership.create({
        data: { operatorId: operator.id, userId: platform.id, role: OperatorMemberRole.STAFF },
      })
      await raw.user.update({
        where: { id: archived.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })
      await raw.user.update({ where: { id: tombstoned.id }, data: { deletedAt: new Date() } })
      await raw.facilityManager.deleteMany({})

      for (const statement of backfillStatements()) {
        await raw.$executeRawUnsafe(statement)
      }

      const granted = await raw.facilityManager.findMany({
        where: { facilityId: facility.id },
        select: { userId: true },
      })
      expect(granted.map((r) => r.userId).sort()).toEqual([admin.id, staff.id, peer.id].sort())
      for (const excluded of [consumer, archived, tombstoned, platform]) {
        expect(granted.some((r) => r.userId === excluded.id)).toBe(false)
      }
    })

    it('backfills nothing for the memberless unclaimed-import operator', async () => {
      await seedUnclaimedOperator(raw)
      const imported = await seedFacility(raw, { operatorId: UNCLAIMED_OPERATOR_ID, ...CENTRE })
      await raw.facilityManager.deleteMany({})

      for (const statement of backfillStatements()) {
        await raw.$executeRawUnsafe(statement)
      }

      expect(await raw.facilityManager.count({ where: { facilityId: imported.id } })).toBe(0)
    })
  })
})
