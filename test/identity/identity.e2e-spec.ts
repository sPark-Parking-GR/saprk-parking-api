import { ApprovalStatus, LifecycleStatus, PrismaClient, UserRole, type User } from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import request from 'supertest'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import { seedOperator, seedUser } from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'
const USERS = `${API}/admin/users`

/**
 * The account-management surface end to end.
 *
 * Two properties matter more than the rest and are asserted per verb rather than by one
 * representative: a platform admin can reach NONE of this, and a super administrator can be
 * acted on only through the demotion flow, which needs a second super admin to agree.
 */
describe('admin identity over HTTP (e2e)', () => {
  let app: NestFastifyApplication
  let raw: PrismaClient

  let superOne: User
  let superTwo: User
  let platformAdmin: User
  let target: User

  let superOneToken: string
  let superTwoToken: string
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

    superOne = await seedUser(raw, { role: UserRole.SUPER_ADMIN })
    superTwo = await seedUser(raw, { role: UserRole.SUPER_ADMIN })
    platformAdmin = await seedUser(raw, { role: UserRole.PLATFORM_ADMIN })
    target = await seedUser(raw, { role: UserRole.USER })

    superOneToken = bearerToken(superOne)
    superTwoToken = bearerToken(superTwo)
    platformToken = bearerToken(platformAdmin)
  })

  function get(path: string, token?: string) {
    const req = request(app.getHttpServer()).get(`${USERS}${path}`)
    return token ? req.set('authorization', `Bearer ${token}`) : req
  }

  function post(path: string, token: string | undefined, body: object = {}) {
    const req = request(app.getHttpServer()).post(`${USERS}${path}`)
    if (token) req.set('authorization', `Bearer ${token}`)
    return req.send(body)
  }

  function patch(path: string, token: string | undefined, body: object = {}) {
    const req = request(app.getHttpServer()).patch(`${USERS}${path}`)
    if (token) req.set('authorization', `Bearer ${token}`)
    return req.send(body)
  }

  describe('the tier boundary', () => {
    function endpoints() {
      return [
        { name: 'GET list', call: (t?: string) => get('', t), admitted: 200 },
        { name: 'GET detail', call: (t?: string) => get(`/${target.id}`, t), admitted: 200 },
        { name: 'GET approvals', call: (t?: string) => get('/approvals', t), admitted: 200 },
        {
          name: 'PATCH role',
          call: (t?: string) =>
            patch(`/${target.id}/role`, t, { role: UserRole.PLATFORM_ADMIN, reason: 'gate test' }),
          admitted: 204,
        },
        {
          name: 'POST demote',
          // Not a super admin, so an admitted caller gets 409 — after the gate let them in.
          call: (t?: string) => post(`/${target.id}/demote`, t, { reason: 'gate test' }),
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

    it('exposes exactly the seven routes of the contract', () => {
      expect(endpoints()).toHaveLength(7)
    })

    it.each(endpoints().map((e, index) => [e.name, index] as const))(
      '%s admits a super admin and refuses a platform admin',
      async (_name, index) => {
        const endpoint = endpoints()[index]!
        await endpoint.call(superOneToken).expect(endpoint.admitted)
        await endpoint.call(platformToken).expect(403)
        await endpoint.call(undefined).expect(401)
      },
    )

    it('leaves the account untouched after a platform admin is refused', async () => {
      await patch(`/${target.id}/role`, platformToken, {
        role: UserRole.PLATFORM_ADMIN,
        reason: 'should not happen',
      }).expect(403)

      const after = await raw.user.findUniqueOrThrow({ where: { id: target.id } })
      expect(after.role).toBe(UserRole.USER)
      expect(after.sessionsValidFrom).toBeNull()
    })
  })

  describe('the directory', () => {
    it('finds accounts the ordinary API hides, across every lifecycle status', async () => {
      const archived = await seedUser(raw, { role: UserRole.USER })
      await raw.user.update({
        where: { id: archived.id },
        data: { lifecycleStatus: LifecycleStatus.ARCHIVED },
      })

      const all = await get('', superOneToken).expect(200)
      expect(all.body.items.map((u: { id: string }) => u.id)).toContain(archived.id)

      const filtered = await get('?lifecycleStatus=ARCHIVED', superOneToken).expect(200)
      expect(filtered.body.items).toHaveLength(1)
      expect(filtered.body.items[0].id).toBe(archived.id)
    })

    it('searches by email and filters by role and operator', async () => {
      const operator = await seedOperator(raw)
      const member = await seedUser(raw, {
        role: UserRole.OPERATOR_ADMIN,
        operatorId: operator.id,
      })

      const byRole = await get(`?role=${UserRole.OPERATOR_ADMIN}`, superOneToken).expect(200)
      expect(byRole.body.items.map((u: { id: string }) => u.id)).toEqual([member.id])

      const byOperator = await get(`?operatorId=${operator.id}`, superOneToken).expect(200)
      expect(byOperator.body.items.map((u: { id: string }) => u.id)).toEqual([member.id])

      const bySearch = await get(`?q=${encodeURIComponent(member.email)}`, superOneToken).expect(200)
      expect(bySearch.body.items).toHaveLength(1)
    })

    it('reports the page window and pages through', async () => {
      const first = await get('?take=2', superOneToken).expect(200)

      expect(first.body).toMatchObject({ skip: 0, take: 2 })
      expect(first.body.items).toHaveLength(2)
      expect(first.body.total).toBeGreaterThanOrEqual(4)

      const second = await get('?take=2&skip=2', superOneToken).expect(200)
      const firstIds = first.body.items.map((u: { id: string }) => u.id)
      const secondIds = second.body.items.map((u: { id: string }) => u.id)
      expect(secondIds).not.toEqual(expect.arrayContaining(firstIds))
    })

    it('carries memberships and the account audit trail into the detail view', async () => {
      const operator = await seedOperator(raw)
      const member = await seedUser(raw, {
        role: UserRole.OPERATOR_ADMIN,
        operatorId: operator.id,
      })

      await patch(`/${member.id}/role`, superOneToken, {
        role: UserRole.PLATFORM_ADMIN,
        reason: 'joined ops',
      }).expect(204)

      const detail = await get(`/${member.id}`, superOneToken).expect(200)
      expect(detail.body.memberships).toEqual([
        expect.objectContaining({ operatorId: operator.id, operatorName: operator.name }),
      ])
      expect(detail.body.recentActivity[0]).toMatchObject({ action: 'user.role_changed' })
    })

    it('404s an unknown account rather than returning an empty body', async () => {
      await get('/does-not-exist', superOneToken).expect(404)
    })
  })

  describe('assigning a platform role', () => {
    it('grants the role, revokes outstanding tokens and audits the motive', async () => {
      await patch(`/${target.id}/role`, superOneToken, {
        role: UserRole.PLATFORM_ADMIN,
        reason: 'joined the ops team',
      }).expect(204)

      const after = await raw.user.findUniqueOrThrow({ where: { id: target.id } })
      expect(after.role).toBe(UserRole.PLATFORM_ADMIN)
      expect(after.sessionsValidFrom).toBeInstanceOf(Date)

      const audit = await raw.auditLog.findFirstOrThrow({ where: { action: 'user.role_changed' } })
      expect(audit).toMatchObject({ actorId: superOne.id, entityType: 'User', entityId: target.id })
      expect(audit.payload).toMatchObject({
        from: UserRole.USER,
        to: UserRole.PLATFORM_ADMIN,
        reason: 'joined the ops team',
      })
    })

    it('refuses to let a super admin re-role themselves', async () => {
      await patch(`/${superOne.id}/role`, superOneToken, {
        role: UserRole.USER,
        reason: 'nope',
      }).expect(409)

      const after = await raw.user.findUniqueOrThrow({ where: { id: superOne.id } })
      expect(after.role).toBe(UserRole.SUPER_ADMIN)
    })

    it('refuses to re-role another super admin, pointing at the demotion flow', async () => {
      const response = await patch(`/${superTwo.id}/role`, superOneToken, {
        role: UserRole.USER,
        reason: 'nope',
      }).expect(409)

      expect(response.body.message).toMatch(/demote/i)
    })

    it('demands a reason', async () => {
      await patch(`/${target.id}/role`, superOneToken, { role: UserRole.PLATFORM_ADMIN }).expect(400)
    })

    it('refuses an operator role, which membership derives rather than this endpoint', async () => {
      await patch(`/${target.id}/role`, superOneToken, {
        role: UserRole.OPERATOR_ADMIN,
        reason: 'wrong axis',
      }).expect(400)
    })

    /**
     * Revoking platform authority falls back to what membership already says, rather than
     * writing USER flat — otherwise the global role and the membership role disagree until
     * a later membership change silently corrects it.
     */
    it('falls back to the operator role the memberships imply', async () => {
      const operator = await seedOperator(raw)
      const member = await seedUser(raw, {
        role: UserRole.OPERATOR_ADMIN,
        operatorId: operator.id,
      })
      await patch(`/${member.id}/role`, superOneToken, {
        role: UserRole.PLATFORM_ADMIN,
        reason: 'promote',
      }).expect(204)

      await patch(`/${member.id}/role`, superOneToken, {
        role: UserRole.USER,
        reason: 'revoke',
      }).expect(204)

      const after = await raw.user.findUniqueOrThrow({ where: { id: member.id } })
      expect(after.role).toBe(UserRole.OPERATOR_ADMIN)
    })
  })

  describe('the two-person rule over super administrators', () => {
    it('files a request without changing anything', async () => {
      const response = await post(`/${superTwo.id}/demote`, superOneToken, {
        reason: 'left the company',
      }).expect(202)

      expect(response.body).toMatchObject({
        resourceId: superTwo.id,
        status: ApprovalStatus.PENDING,
        requestedBy: superOne.id,
      })

      const after = await raw.user.findUniqueOrThrow({ where: { id: superTwo.id } })
      expect(after.role).toBe(UserRole.SUPER_ADMIN)
    })

    it('refuses to let the requester redeem their own request', async () => {
      const filed = await post(`/${superTwo.id}/demote`, superOneToken, {
        reason: 'left the company',
      }).expect(202)

      // 403, the same status the purge two-person rule returns for self-approval.
      await post(`/approvals/${filed.body.id}/approve`, superOneToken).expect(403)

      const after = await raw.user.findUniqueOrThrow({ where: { id: superTwo.id } })
      expect(after.role).toBe(UserRole.SUPER_ADMIN)
    })

    it('demotes once a DIFFERENT super admin redeems it', async () => {
      const third = await seedUser(raw, { role: UserRole.SUPER_ADMIN })
      const filed = await post(`/${third.id}/demote`, superOneToken, {
        reason: 'left the company',
      }).expect(202)

      await post(`/approvals/${filed.body.id}/approve`, superTwoToken).expect(200)

      const after = await raw.user.findUniqueOrThrow({ where: { id: third.id } })
      expect(after.role).toBe(UserRole.USER)
      expect(after.sessionsValidFrom).toBeInstanceOf(Date)

      const audit = await raw.auditLog.findFirstOrThrow({ where: { action: 'user.demoted' } })
      expect(audit.payload).toMatchObject({ requestedBy: superOne.id })
    })

    it('refuses a second request while one is already pending', async () => {
      await post(`/${superTwo.id}/demote`, superOneToken, { reason: 'first' }).expect(202)
      await post(`/${superTwo.id}/demote`, superOneToken, { reason: 'second' }).expect(409)
    })

    it('refuses to demote the last super admin', async () => {
      // superOne asks about superTwo, then only superOne would be left holding the tier.
      await raw.user.delete({ where: { id: platformAdmin.id } })
      const soleTarget = superTwo.id
      await post(`/${soleTarget}/demote`, superOneToken, { reason: 'first' }).expect(202)

      // Now demote superOne too: nobody would remain.
      await raw.user.update({
        where: { id: soleTarget },
        data: { role: UserRole.USER },
      })
      await post(`/${superOne.id}/demote`, superTwoToken, { reason: 'second' }).expect(409)
    })

    it('withdraws cleanly when rejected, leaving the account alone', async () => {
      const filed = await post(`/${superTwo.id}/demote`, superOneToken, {
        reason: 'mistake',
      }).expect(202)

      await post(`/approvals/${filed.body.id}/reject`, superOneToken, {
        reason: 'changed my mind',
      }).expect(200)

      const after = await raw.user.findUniqueOrThrow({ where: { id: superTwo.id } })
      expect(after.role).toBe(UserRole.SUPER_ADMIN)

      const approvals = await get('/approvals', superOneToken).expect(200)
      expect(approvals.body.items).toHaveLength(0)
    })

    it('refuses to demote an account that is not a super admin', async () => {
      await post(`/${target.id}/demote`, superOneToken, { reason: 'wrong target' }).expect(409)
    })
  })

  describe('super administrators are unreachable by the lifecycle verbs', () => {
    const LIFECYCLE = `${API}/admin/lifecycle`

    function lifecyclePost(path: string, token: string, body: object = {}) {
      return request(app.getHttpServer())
        .post(`${LIFECYCLE}${path}`)
        .set('authorization', `Bearer ${token}`)
        .send(body)
    }

    it.each(['archive', 'tombstone', 'purge'])(
      'refuses to %s a super administrator, even for a super admin',
      async (verb) => {
        const response = await lifecyclePost(`/user/${superTwo.id}/${verb}`, superOneToken, {
          reason: 'boundary test',
        }).expect(409)

        expect(response.body.message).toMatch(/demote/i)

        const after = await raw.user.findUniqueOrThrow({ where: { id: superTwo.id } })
        expect(after.lifecycleStatus).toBe(LifecycleStatus.ACTIVE)
      },
    )

    it('still suspends an ordinary account', async () => {
      await lifecyclePost(`/user/${target.id}/archive`, superOneToken, {
        reason: 'boundary test',
      }).expect(204)

      const after = await raw.user.findUniqueOrThrow({ where: { id: target.id } })
      expect(after.lifecycleStatus).toBe(LifecycleStatus.ARCHIVED)
    })
  })
})
