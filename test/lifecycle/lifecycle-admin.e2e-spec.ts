import {
  ApprovalStatus,
  BookingStatus,
  LifecycleStatus,
  PrismaClient,
  UserRole,
  type User,
} from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import request from 'supertest'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  seedBooking,
  seedFacility,
  seedOperator,
  seedSavedFacility,
  seedTariffPlan,
  seedUser,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'
const LIFECYCLE = `${API}/admin/lifecycle`
const CENTRE = { lat: 37.9838, lng: 23.7275 }
const FUTURE = new Date('2027-01-10T10:00:00.000Z')
const FUTURE_END = new Date('2027-01-10T12:00:00.000Z')
const PAST = new Date('2026-01-10T10:00:00.000Z')
const PAST_END = new Date('2026-01-10T12:00:00.000Z')

interface Blocker {
  code: string
  message: string
  remedy: string
}

interface Warning {
  code: string
  message: string
  count: number
}

interface ImpactBody {
  blockers: Blocker[]
  warnings: Warning[]
  effects: Array<{ entity: string; action: string; count: number }>
  requiresForce: boolean
}

describe('admin lifecycle over HTTP (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  // Unextended client: writes and reads the non-ACTIVE states the extended client hides.
  let raw: PrismaClient

  let requester: User
  let approver: User
  let secondApprover: User
  let requesterToken: string
  let approverToken: string
  let secondApproverToken: string

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    prisma = testApp.prisma
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
  })

  /** Three purge-capable admins, so the two-person rule has room to be exercised. */
  async function seedAdmins(): Promise<void> {
    requester = await seedUser(raw, { role: UserRole.PLATFORM_ADMIN })
    approver = await seedUser(raw, { role: UserRole.PLATFORM_ADMIN })
    secondApprover = await seedUser(raw, { role: UserRole.PLATFORM_ADMIN })
    requesterToken = bearerToken(requester)
    approverToken = bearerToken(approver)
    secondApproverToken = bearerToken(secondApprover)
  }

  function post(path: string, token: string | undefined, body: object = {}) {
    const req = request(app.getHttpServer()).post(`${LIFECYCLE}${path}`)
    if (token) req.set('authorization', `Bearer ${token}`)
    return req.send(body)
  }

  function get(path: string, token?: string) {
    const req = request(app.getHttpServer()).get(`${LIFECYCLE}${path}`)
    return token ? req.set('authorization', `Bearer ${token}`) : req
  }

  function auditCount(action: string): Promise<number> {
    return raw.auditLog.count({ where: { action } })
  }

  describe('permission gates', () => {
    let facilityId: string
    let platformToken: string
    let operatorAdminToken: string
    let operatorStaffToken: string
    let consumerToken: string

    beforeEach(async () => {
      const operator = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
      facilityId = facility.id

      const [platform, operatorAdmin, operatorStaff, consumer] = await Promise.all([
        seedUser(raw, { role: UserRole.PLATFORM_ADMIN }),
        seedUser(raw, { role: UserRole.OPERATOR_ADMIN, operatorId: operator.id }),
        seedUser(raw, { role: UserRole.OPERATOR_STAFF, operatorId: operator.id }),
        seedUser(raw, { role: UserRole.USER }),
      ])
      platformToken = bearerToken(platform)
      operatorAdminToken = bearerToken(operatorAdmin)
      operatorStaffToken = bearerToken(operatorStaff)
      consumerToken = bearerToken(consumer)
    })

    function endpoints() {
      return [
        { name: 'GET trash', call: (t?: string) => get('/trash', t), admitted: 200 },
        {
          name: 'GET impact',
          call: (t?: string) => get(`/facility/${facilityId}/impact`, t),
          admitted: 200,
        },
        { name: 'GET approvals', call: (t?: string) => get('/approvals', t), admitted: 200 },
        {
          name: 'POST archive',
          call: (t?: string) => post(`/facility/${facilityId}/archive`, t, { reason: 'gate test' }),
          admitted: 204,
        },
        {
          name: 'POST restore',
          call: (t?: string) => post(`/facility/${facilityId}/restore`, t, {}),
          // Nothing to restore from ACTIVE; the gate is what this asserts, not the outcome.
          admitted: 409,
        },
        {
          name: 'POST tombstone',
          call: (t?: string) =>
            post(`/facility/${facilityId}/tombstone`, t, { reason: 'gate test' }),
          admitted: 204,
        },
        {
          name: 'POST purge',
          call: (t?: string) => post(`/facility/${facilityId}/purge`, t, { reason: 'gate test' }),
          // ACTIVE, so the dry run blocks it — after the gate has admitted the caller.
          admitted: 409,
        },
        {
          name: 'POST approve',
          call: (t?: string) => post('/approvals/does-not-exist/approve', t),
          admitted: 404,
        },
        {
          name: 'POST reject',
          call: (t?: string) =>
            post('/approvals/does-not-exist/reject', t, { reason: 'not a real approval' }),
          admitted: 404,
        },
      ]
    }

    it('exposes exactly the nine endpoints of the contract', () => {
      expect(endpoints()).toHaveLength(9)
    })

    it.each(endpoints().map((endpoint, index) => [endpoint.name, index] as const))(
      '%s admits a platform admin and refuses every operator role',
      async (_name, index) => {
        const endpoint = endpoints()[index]!
        await endpoint.call(platformToken).expect(endpoint.admitted)
        await endpoint.call(operatorAdminToken).expect(403)
        await endpoint.call(operatorStaffToken).expect(403)
        await endpoint.call(consumerToken).expect(403)
        await endpoint.call(undefined).expect(401)
      },
    )
  })

  describe('resourceType validation', () => {
    beforeEach(seedAdmins)

    it('rejects an unknown resourceType before anything touches the database', async () => {
      const impact = await get('/spaceship/abc/impact', requesterToken).expect(400)
      expect(impact.body.message).toBe('Validation failed')

      await post('/spaceship/abc/archive', requesterToken, { reason: 'nope' }).expect(400)
      await post('/User/abc/archive', requesterToken, { reason: 'nope' }).expect(400)
      await post('/tariffPlan/abc/purge', requesterToken, { reason: 'nope' }).expect(400)
    })

    it('accepts every resourceType the contract names', async () => {
      for (const type of ['user', 'operator', 'facility', 'tariff-plan']) {
        // 404 rather than 400: the enum let it through and the id did not resolve.
        await get(`/${type}/missing-id/impact`, requesterToken).expect(404)
      }
    })

    it('requires a reason on every destructive action', async () => {
      const operator = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })

      await post(`/facility/${facility.id}/archive`, requesterToken, {}).expect(400)
      await post(`/facility/${facility.id}/tombstone`, requesterToken, { reason: '' }).expect(400)
      await post(`/facility/${facility.id}/purge`, requesterToken, {}).expect(400)
    })
  })

  describe('archive and restore round trip', () => {
    beforeEach(seedAdmins)

    it('archives then restores a facility exactly, auditing each with its reason and the caller IP', async () => {
      const operator = await seedOperator(raw)
      const facility = await seedFacility(raw, {
        operatorId: operator.id,
        ...CENTRE,
        isActive: true,
      })

      await post(`/facility/${facility.id}/archive`, requesterToken, {
        reason: 'seasonal closure',
      }).expect(204)

      const archived = await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })
      expect(archived.lifecycleStatus).toBe(LifecycleStatus.ARCHIVED)
      expect(archived.isActive).toBe(false)
      expect(archived.lifecycleReason).toBe('seasonal closure')
      expect(archived.lifecycleChangedBy).toBe(requester.id)

      expect(await auditCount('facility.archived')).toBe(1)
      const archiveAudit = await raw.auditLog.findFirstOrThrow({
        where: { action: 'facility.archived' },
      })
      expect(archiveAudit.actorId).toBe(requester.id)
      expect(archiveAudit.actorRole).toBe('platform_admin')
      expect(archiveAudit.entityType).toBe('Facility')
      expect(archiveAudit.entityId).toBe(facility.id)
      expect(archiveAudit.payload).toMatchObject({ reason: 'seasonal closure' })
      expect(archiveAudit.ipAddress).toBeTruthy()

      // The archived row is invisible to the ordinary API but present in the trash.
      expect(await prisma.facility.findUnique({ where: { id: facility.id } })).toBeNull()
      const trash = await get('/trash?resourceType=facility', requesterToken).expect(200)
      expect(trash.body.total).toBe(1)
      expect(trash.body.items[0]).toMatchObject({
        resourceType: 'facility',
        id: facility.id,
        status: LifecycleStatus.ARCHIVED,
        reason: 'seasonal closure',
        changedBy: requester.id,
      })

      await post(`/facility/${facility.id}/restore`, requesterToken, {
        reason: 'reopened early',
      }).expect(204)

      const restored = await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })
      expect(restored.lifecycleStatus).toBe(LifecycleStatus.ACTIVE)
      // Restore never republishes: archive unpublished it and only the operator may undo that.
      expect(restored.isActive).toBe(false)
      expect(restored.lifecycleReason).toBeNull()
      expect(restored.purgeAfter).toBeNull()

      expect(await auditCount('facility.restored')).toBe(1)
      const restoreAudit = await raw.auditLog.findFirstOrThrow({
        where: { action: 'facility.restored' },
      })
      expect(restoreAudit.payload).toMatchObject({ reason: 'reopened early' })

      const emptied = await get('/trash', requesterToken).expect(200)
      expect(emptied.body.total).toBe(0)
    })

    it('round-trips every resource type through the trash listing', async () => {
      const operator = await seedOperator(raw)
      const plan = await seedTariffPlan(raw, { operatorId: operator.id })
      const consumer = await seedUser(raw, { role: UserRole.USER })

      await post(`/tariff-plan/${plan.id}/archive`, requesterToken, {
        reason: 'archived for the trash listing',
      }).expect(204)
      await post(`/user/${consumer.id}/archive`, requesterToken, {
        reason: 'archived for the trash listing',
      }).expect(204)
      await post(`/operator/${operator.id}/archive`, requesterToken, {
        reason: 'archived for the trash listing',
      }).expect(204)

      const trash = await get('/trash?take=100', requesterToken).expect(200)
      expect(trash.body.total).toBe(3)
      expect(
        trash.body.items.map((item: { resourceType: string }) => item.resourceType).sort(),
      ).toEqual(['operator', 'tariff-plan', 'user'])

      const onlyUsers = await get('/trash?resourceType=user', requesterToken).expect(200)
      expect(onlyUsers.body.total).toBe(1)
      expect(onlyUsers.body.items[0].id).toBe(consumer.id)

      for (const [type, id] of [
        ['tariff-plan', plan.id],
        ['user', consumer.id],
        ['operator', operator.id],
      ] as const) {
        await post(`/${type}/${id}/restore`, requesterToken, {}).expect(204)
      }
      expect((await get('/trash', requesterToken).expect(200)).body.total).toBe(0)
    })

    it('revokes live sessions when a user is archived, and does not re-issue them on restore', async () => {
      const consumer = await seedUser(raw, { role: UserRole.USER })

      await post(`/user/${consumer.id}/archive`, requesterToken, { reason: 'abuse' }).expect(204)

      const archived = await raw.user.findUniqueOrThrow({ where: { id: consumer.id } })
      expect(archived.sessionsValidFrom).not.toBeNull()

      await post(`/user/${consumer.id}/restore`, requesterToken, {}).expect(204)
      const restored = await raw.user.findUniqueOrThrow({ where: { id: consumer.id } })
      expect(restored.sessionsValidFrom).toEqual(archived.sessionsValidFrom)
    })
  })

  describe('restore re-validates invariants and says what is wrong', () => {
    beforeEach(seedAdmins)

    it('refuses to restore a facility whose operator filled the one-facility cap, naming the conflict', async () => {
      const operator = await seedOperator(raw)
      const original = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
      await post(`/facility/${original.id}/archive`, requesterToken, {
        reason: 'archived by the test fixture',
      }).expect(204)
      const replacement = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })

      const response = await post(`/facility/${original.id}/restore`, requesterToken, {}).expect(
        409,
      )
      expect(response.body.message).toContain(replacement.id)
      expect(response.body.message).toContain('may own only one')
      expect(response.body.message).not.toBe('Internal server error')

      const untouched = await raw.facility.findUniqueOrThrow({ where: { id: original.id } })
      expect(untouched.lifecycleStatus).toBe(LifecycleStatus.ARCHIVED)
    })

    it('refuses to restore a default tariff plan once another plan holds the default slot', async () => {
      const operator = await seedOperator(raw)
      const original = await seedTariffPlan(raw, { operatorId: operator.id, isDefault: true })
      await post(`/tariff-plan/${original.id}/archive`, requesterToken, {
        reason: 'archived by the test fixture',
      }).expect(204)
      const successor = await seedTariffPlan(raw, { operatorId: operator.id, isDefault: true })

      const response = await post(`/tariff-plan/${original.id}/restore`, requesterToken, {}).expect(
        409,
      )
      expect(response.body.message).toContain(successor.id)
      expect(response.body.message).toContain("operator's active default")
    })

    it('refuses to restore an account that account deletion already anonymised', async () => {
      const consumer = await seedUser(raw, { role: UserRole.USER })
      await raw.user.update({
        where: { id: consumer.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED, deletedAt: new Date() },
      })

      const response = await post(`/user/${consumer.id}/restore`, requesterToken, {}).expect(409)
      expect(response.body.message).toContain('anonymised')
    })

    it('answers 404 for a resource that does not exist, not 500', async () => {
      await post('/facility/no-such-facility/restore', requesterToken, {}).expect(404)
    })
  })

  describe('impact preview', () => {
    beforeEach(seedAdmins)

    it('blocks a facility archive on unhonoured bookings and lets a warned one through', async () => {
      const blockedOperator = await seedOperator(raw)
      const blocked = await seedFacility(raw, { operatorId: blockedOperator.id, ...CENTRE })
      const consumer = await seedUser(raw, { role: UserRole.USER })
      await seedBooking(raw, {
        facilityId: blocked.id,
        userId: consumer.id,
        startsAt: FUTURE,
        endsAt: FUTURE_END,
        status: BookingStatus.CONFIRMED,
      })

      const preview = await get(
        `/facility/${blocked.id}/impact?action=archive`,
        requesterToken,
      ).expect(200)
      const body = preview.body as ImpactBody
      expect(body.blockers.map((blocker) => blocker.code)).toContain(
        'FACILITY_HAS_UNHONOURED_BOOKINGS',
      )
      expect(body.blockers[0]!.remedy).toBeTruthy()

      const refused = await post(`/facility/${blocked.id}/archive`, requesterToken, {
        reason: 'try anyway',
      }).expect(409)
      expect(refused.body.blockers[0].code).toBe('FACILITY_HAS_UNHONOURED_BOOKINGS')
      expect(
        (await raw.facility.findUniqueOrThrow({ where: { id: blocked.id } })).lifecycleStatus,
      ).toBe(LifecycleStatus.ACTIVE)
      expect(await auditCount('facility.archived')).toBe(0)

      // A warning describes a consequence, and must never stop the action.
      const warnedOperator = await seedOperator(raw)
      const warned = await seedFacility(raw, { operatorId: warnedOperator.id, ...CENTRE })
      await seedSavedFacility(raw, { userId: consumer.id, facilityId: warned.id })

      const warnedPreview = await get(
        `/facility/${warned.id}/impact?action=archive`,
        requesterToken,
      ).expect(200)
      const warnedBody = warnedPreview.body as ImpactBody
      expect(warnedBody.blockers).toEqual([])
      expect(warnedBody.warnings.map((warning) => warning.code)).toEqual(
        expect.arrayContaining(['FACILITY_SAVED_BY_USERS', 'FACILITY_WILL_UNPUBLISH']),
      )
      expect(warnedBody.requiresForce).toBe(true)

      await post(`/facility/${warned.id}/archive`, requesterToken, {
        reason: 'warned and consented',
      }).expect(204)
      expect(
        (await raw.facility.findUniqueOrThrow({ where: { id: warned.id } })).lifecycleStatus,
      ).toBe(LifecycleStatus.ARCHIVED)
    })

    it('defaults to the purge preview, the worst case, when no action is named', async () => {
      const operator = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })

      const body = (await get(`/facility/${facility.id}/impact`, requesterToken).expect(200))
        .body as ImpactBody
      expect(body.blockers.map((blocker) => blocker.code)).toContain('INVALID_LIFECYCLE_STATE')
    })

    it('reports the financial history that pins a facility against purge forever', async () => {
      const operator = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
      const consumer = await seedUser(raw, { role: UserRole.USER })
      await seedBooking(raw, {
        facilityId: facility.id,
        userId: consumer.id,
        startsAt: PAST,
        endsAt: PAST_END,
        status: BookingStatus.CHECKED_OUT,
      })
      await raw.facility.update({
        where: { id: facility.id },
        data: { lifecycleStatus: LifecycleStatus.TOMBSTONED, purgeAfter: new Date() },
      })

      const body = (await get(`/facility/${facility.id}/impact?action=purge`, requesterToken)
        .expect(200)
        .then((response) => response.body)) as ImpactBody
      const pinned = body.blockers.find((blocker) => blocker.code === 'FACILITY_PINNED_BY_BOOKINGS')
      expect(pinned).toBeDefined()
      expect(pinned!.remedy).toContain('tombstone')
    })

    it('blocks an operator archive while it still owns an active facility', async () => {
      const operator = await seedOperator(raw)
      await seedFacility(raw, { operatorId: operator.id, ...CENTRE })

      const body = (await get(`/operator/${operator.id}/impact?action=archive`, requesterToken)
        .expect(200)
        .then((response) => response.body)) as ImpactBody
      expect(body.blockers.map((blocker) => blocker.code)).toContain(
        'OPERATOR_HAS_ACTIVE_FACILITIES',
      )

      await post(`/operator/${operator.id}/archive`, requesterToken, {
        reason: 'archived by the test fixture',
      }).expect(409)
    })

    it('warns rather than blocks when a user carries booking history', async () => {
      const operator = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
      const consumer = await seedUser(raw, { role: UserRole.USER })
      await seedBooking(raw, {
        facilityId: facility.id,
        userId: consumer.id,
        startsAt: PAST,
        endsAt: PAST_END,
        status: BookingStatus.CHECKED_OUT,
      })

      const body = (await get(`/user/${consumer.id}/impact?action=archive`, requesterToken)
        .expect(200)
        .then((response) => response.body)) as ImpactBody
      expect(body.blockers).toEqual([])
      expect(body.warnings.map((warning) => warning.code)).toEqual(
        expect.arrayContaining(['USER_HAS_BOOKING_HISTORY', 'USER_SESSIONS_REVOKED']),
      )
      expect(body.effects).toEqual(
        expect.arrayContaining([{ entity: 'User', action: 'archive', count: 1 }]),
      )
    })

    it('warns that purging an active default plan strands the operator fallback price', async () => {
      const operator = await seedOperator(raw)
      const plan = await seedTariffPlan(raw, { operatorId: operator.id, isDefault: true })

      const body = (await get(`/tariff-plan/${plan.id}/impact?action=archive`, requesterToken)
        .expect(200)
        .then((response) => response.body)) as ImpactBody
      expect(body.blockers).toEqual([])
      expect(body.warnings.map((warning) => warning.code)).toContain(
        'TARIFF_PLAN_IS_OPERATOR_DEFAULT',
      )
    })

    it('never writes: the preview runs in a read-only transaction', async () => {
      const operator = await seedOperator(raw)
      const facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
      const before = await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })

      await get(`/facility/${facility.id}/impact?action=archive`, requesterToken).expect(200)

      expect(await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })).toEqual(before)
      expect(await raw.auditLog.count()).toBe(0)
    })
  })

  describe('two-person rule', () => {
    async function tombstonedPlan(): Promise<string> {
      const operator = await seedOperator(raw)
      const plan = await seedTariffPlan(raw, { operatorId: operator.id })
      await post(`/tariff-plan/${plan.id}/tombstone`, requesterToken, {
        reason: 'duplicate plan',
      }).expect(204)
      return plan.id
    }

    it('fails closed on a fresh install: one purge holder means no purge at all', async () => {
      const sole = await seedUser(raw, { role: UserRole.PLATFORM_ADMIN })
      const soleToken = bearerToken(sole)
      const operator = await seedOperator(raw)
      const plan = await seedTariffPlan(raw, { operatorId: operator.id })
      await post(`/tariff-plan/${plan.id}/tombstone`, soleToken, {
        reason: 'archived by the test fixture',
      }).expect(204)

      const response = await post(`/tariff-plan/${plan.id}/purge`, soleToken, {
        reason: 'nobody to ask',
      }).expect(409)
      expect(response.body.message).toContain('second platform administrator')

      expect(await raw.pendingApproval.count()).toBe(0)
      expect(await auditCount('lifecycle.purge_requested')).toBe(0)
      expect(await raw.tariffPlan.count({ where: { id: plan.id } })).toBe(1)
    })

    it('does not count an archived or deleted admin as the second pair of eyes', async () => {
      const sole = await seedUser(raw, { role: UserRole.PLATFORM_ADMIN })
      const archivedAdmin = await seedUser(raw, { role: UserRole.PLATFORM_ADMIN })
      await raw.user.update({
        where: { id: archivedAdmin.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })
      const soleToken = bearerToken(sole)
      const operator = await seedOperator(raw)
      const plan = await seedTariffPlan(raw, { operatorId: operator.id })
      await post(`/tariff-plan/${plan.id}/tombstone`, soleToken, {
        reason: 'archived by the test fixture',
      }).expect(204)

      await post(`/tariff-plan/${plan.id}/purge`, soleToken, { reason: 'still alone' }).expect(409)
    })

    describe('with a second administrator available', () => {
      beforeEach(seedAdmins)

      it('files a request instead of purging, and audits the ask', async () => {
        const planId = await tombstonedPlan()

        const response = await post(`/tariff-plan/${planId}/purge`, requesterToken, {
          reason: 'GDPR erasure 4471',
        }).expect(202)

        expect(response.body).toMatchObject({
          action: 'purge',
          resourceType: 'tariff-plan',
          resourceId: planId,
          reason: 'GDPR erasure 4471',
          requestedBy: requester.id,
          status: ApprovalStatus.PENDING,
        })
        const expiresIn = new Date(response.body.expiresAt).getTime() - Date.now()
        expect(expiresIn).toBeGreaterThan(23 * 3_600_000)
        expect(expiresIn).toBeLessThanOrEqual(24 * 3_600_000 + 60_000)

        // Nothing destroyed yet.
        expect(await raw.tariffPlan.count({ where: { id: planId } })).toBe(1)
        expect(await auditCount('lifecycle.purge_requested')).toBe(1)
        expect(await auditCount('tariff_plan.purged')).toBe(0)

        const audit = await raw.auditLog.findFirstOrThrow({
          where: { action: 'lifecycle.purge_requested' },
        })
        expect(audit.actorId).toBe(requester.id)
        expect(audit.entityType).toBe('TariffPlan')
        expect(audit.entityId).toBe(planId)
        expect(audit.payload).toMatchObject({ reason: 'GDPR erasure 4471' })
        expect(audit.ipAddress).toBeTruthy()
      })

      it('refuses the requester their own approval, and lets a different admin through', async () => {
        const planId = await tombstonedPlan()
        const approvalId = (
          await post(`/tariff-plan/${planId}/purge`, requesterToken, {
            reason: 'duplicate',
          }).expect(202)
        ).body.id as string

        const selfApproval = await post(`/approvals/${approvalId}/approve`, requesterToken).expect(
          403,
        )
        expect(selfApproval.body.message).toContain('cannot approve it')
        expect(await raw.tariffPlan.count({ where: { id: planId } })).toBe(1)
        expect(
          (await raw.pendingApproval.findUniqueOrThrow({ where: { id: approvalId } })).status,
        ).toBe(ApprovalStatus.PENDING)

        const approved = await post(`/approvals/${approvalId}/approve`, approverToken).expect(200)
        expect(approved.body.purged).toBe(true)
        expect(approved.body.approval.decidedBy).toBe(approver.id)

        expect(await raw.tariffPlan.count({ where: { id: planId } })).toBe(0)
        expect(
          (await raw.pendingApproval.findUniqueOrThrow({ where: { id: approvalId } })).status,
        ).toBe(ApprovalStatus.APPROVED)

        // One row per action, each naming who did it and why.
        expect(await auditCount('lifecycle.purge_requested')).toBe(1)
        expect(await auditCount('lifecycle.purge_approved')).toBe(1)
        expect(await auditCount('tariff_plan.purged')).toBe(1)
        const purged = await raw.auditLog.findFirstOrThrow({
          where: { action: 'tariff_plan.purged' },
        })
        expect(purged.actorId).toBe(approver.id)
        expect(purged.payload).toMatchObject({
          reason: 'duplicate',
          approvalId,
          requestedBy: requester.id,
        })
      })

      it('cannot redeem an approval whose 24 hours have run out', async () => {
        const planId = await tombstonedPlan()
        const approvalId = (
          await post(`/tariff-plan/${planId}/purge`, requesterToken, { reason: 'stale' }).expect(
            202,
          )
        ).body.id as string

        await raw.pendingApproval.update({
          where: { id: approvalId },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        })

        const expired = await post(`/approvals/${approvalId}/approve`, approverToken).expect(410)
        expect(expired.body.message).toContain('expired')

        expect(await raw.tariffPlan.count({ where: { id: planId } })).toBe(1)
        expect(
          (await raw.pendingApproval.findUniqueOrThrow({ where: { id: approvalId } })).status,
        ).toBe(ApprovalStatus.EXPIRED)
        expect(await auditCount('lifecycle.purge_approved')).toBe(0)

        // The lapsed row must not wedge the resource: a fresh request is allowed.
        await post(`/tariff-plan/${planId}/purge`, requesterToken, { reason: 'retry' }).expect(202)
      })

      it('hides an expired approval from the queue', async () => {
        const planId = await tombstonedPlan()
        const approvalId = (
          await post(`/tariff-plan/${planId}/purge`, requesterToken, { reason: 'stale' }).expect(
            202,
          )
        ).body.id as string

        expect((await get('/approvals', approverToken).expect(200)).body.total).toBe(1)

        await raw.pendingApproval.update({
          where: { id: approvalId },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        })

        expect((await get('/approvals', approverToken).expect(200)).body.total).toBe(0)
      })

      it('refuses a duplicate live request for the same resource', async () => {
        const planId = await tombstonedPlan()
        const first = await post(`/tariff-plan/${planId}/purge`, requesterToken, {
          reason: 'first',
        }).expect(202)

        const duplicate = await post(`/tariff-plan/${planId}/purge`, approverToken, {
          reason: 'second',
        }).expect(409)
        expect(duplicate.body.message).toContain(first.body.id)
        expect(await raw.pendingApproval.count()).toBe(1)
      })

      it('a rejected request destroys nothing and cannot then be approved', async () => {
        const planId = await tombstonedPlan()
        const approvalId = (
          await post(`/tariff-plan/${planId}/purge`, requesterToken, {
            reason: 'wrong plan',
          }).expect(202)
        ).body.id as string

        const rejected = await post(`/approvals/${approvalId}/reject`, approverToken, {
          reason: 'plan is still in use',
        }).expect(200)
        expect(rejected.body.status).toBe(ApprovalStatus.REJECTED)
        expect(rejected.body.decisionReason).toBe('plan is still in use')

        await post(`/approvals/${approvalId}/approve`, secondApproverToken).expect(409)
        expect(await raw.tariffPlan.count({ where: { id: planId } })).toBe(1)
        expect(await auditCount('lifecycle.purge_rejected')).toBe(1)
        expect(await auditCount('tariff_plan.purged')).toBe(0)
      })

      it('re-checks the blockers at approval time, not only when the purge was asked for', async () => {
        const operator = await seedOperator(raw)
        const facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
        await post(`/facility/${facility.id}/tombstone`, requesterToken, {
          reason: 'closing down',
        }).expect(204)
        const approvalId = (
          await post(`/facility/${facility.id}/purge`, requesterToken, {
            reason: 'closing',
          }).expect(202)
        ).body.id as string

        // A booking lands between the request and the decision, pinning the facility.
        const consumer = await seedUser(raw, { role: UserRole.USER })
        await seedBooking(raw, {
          facilityId: facility.id,
          userId: consumer.id,
          startsAt: PAST,
          endsAt: PAST_END,
          status: BookingStatus.CHECKED_OUT,
        })

        const refused = await post(`/approvals/${approvalId}/approve`, approverToken).expect(409)
        expect(refused.body.blockers[0].code).toBe('FACILITY_PINNED_BY_BOOKINGS')
        expect(await raw.facility.count({ where: { id: facility.id } })).toBe(1)
      })

      it('two approvers racing the same approval purge exactly once', async () => {
        const planId = await tombstonedPlan()
        const approvalId = (
          await post(`/tariff-plan/${planId}/purge`, requesterToken, { reason: 'race' }).expect(202)
        ).body.id as string

        const [first, second] = await Promise.all([
          post(`/approvals/${approvalId}/approve`, approverToken),
          post(`/approvals/${approvalId}/approve`, secondApproverToken),
        ])

        const statuses = [first.status, second.status].sort()
        expect(statuses[0]).toBe(200)
        expect(statuses[1]).toBeGreaterThanOrEqual(400)

        expect(await raw.tariffPlan.count({ where: { id: planId } })).toBe(0)
        expect(await auditCount('lifecycle.purge_approved')).toBe(1)
        expect(await auditCount('tariff_plan.purged')).toBe(1)
      })

      it('anonymises rather than deletes a purged user, keeping the financial history', async () => {
        const operator = await seedOperator(raw)
        const facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
        const consumer = await seedUser(raw, { role: UserRole.USER })
        await seedBooking(raw, {
          facilityId: facility.id,
          userId: consumer.id,
          startsAt: PAST,
          endsAt: PAST_END,
          status: BookingStatus.CHECKED_OUT,
        })

        await post(`/user/${consumer.id}/tombstone`, requesterToken, {
          reason: 'erasure request',
        }).expect(204)
        const approvalId = (
          await post(`/user/${consumer.id}/purge`, requesterToken, {
            reason: 'erasure request 88',
          }).expect(202)
        ).body.id as string

        await post(`/approvals/${approvalId}/approve`, approverToken).expect(200)

        const anonymised = await raw.user.findUniqueOrThrow({ where: { id: consumer.id } })
        expect(anonymised.lifecycleStatus).toBe(LifecycleStatus.PURGED)
        expect(anonymised.email).toBe(`deleted+${consumer.id}@deleted.invalid`)
        expect(anonymised.displayName).toBeNull()
        expect(await raw.booking.count({ where: { userId: consumer.id } })).toBe(1)
        expect(await auditCount('user.purged')).toBe(1)
      })

      it('refuses to purge something that was never tombstoned', async () => {
        const operator = await seedOperator(raw)
        const plan = await seedTariffPlan(raw, { operatorId: operator.id })

        const refused = await post(`/tariff-plan/${plan.id}/purge`, requesterToken, {
          reason: 'skip the queue',
        }).expect(409)
        expect(refused.body.blockers[0].code).toBe('INVALID_LIFECYCLE_STATE')
        expect(await raw.pendingApproval.count()).toBe(0)
      })

      it('reports an unknown approval as not found', async () => {
        await post('/approvals/nope/approve', approverToken).expect(404)
        await post('/approvals/nope/reject', approverToken, {
          reason: 'archived by the test fixture',
        }).expect(404)
      })
    })
  })
})
