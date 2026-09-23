import {
  OperatorMemberRole,
  PrismaClient,
  UserRole,
  type ParkingOperator,
  type User,
} from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { DEFAULT_STAFF_SCOPES, ORG_PERMISSIONS } from '@spark/types'
import request from 'supertest'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  seedFacility,
  seedOperator,
  seedOperatorSubscription,
  seedSubscriptionPlan,
  seedUser,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'
const CENTRE = { lat: 37.9838, lng: 23.7275 }

/**
 * The org permission axis: what a member may do INSIDE one operator.
 *
 * The property that matters most is the one that is easiest to break silently — introducing
 * the axis must not change what anybody could already do. Every existing staff account was
 * backfilled with exactly the surface operator_staff already reached, so the first block
 * here is really a regression test against the migration.
 */
describe('org scopes over HTTP (e2e)', () => {
  let app: NestFastifyApplication
  let raw: PrismaClient

  let operator: ParkingOperator
  let admin: User
  let staff: User
  let adminToken: string
  let staffToken: string

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
    await resetThrottle(app)

    operator = await seedOperator(raw)
    await seedFacility(raw, { operatorId: operator.id, ...CENTRE })

    // Setting a member's scopes to anything other than DEFAULT_STAFF_SCOPES is what
    // `team.management` sells, so this suite's operator has to be on a plan that includes
    // it — otherwise every customisation below would be measuring the plan gate rather than
    // the scope machinery it is here to exercise.
    const growth = await seedSubscriptionPlan(raw, {
      id: 'plan_growth',
      code: 'growth',
      name: 'Growth',
      features: ['team.management'],
    })
    await seedOperatorSubscription(raw, { operatorId: operator.id, planId: growth.id })

    admin = await seedUser(raw, { role: UserRole.OPERATOR_ADMIN, operatorId: operator.id })
    staff = await seedUser(raw, {
      role: UserRole.OPERATOR_STAFF,
      operatorId: operator.id,
      memberRole: OperatorMemberRole.STAFF,
    })
    await setScopes(staff.id, [...DEFAULT_STAFF_SCOPES])

    adminToken = bearerToken(admin)
    staffToken = bearerToken(staff)
  })

  async function setScopes(userId: string, scopes: string[]): Promise<void> {
    await raw.operatorMembership.updateMany({
      where: { userId, operatorId: operator.id },
      data: { scopes },
    })
  }

  function get(path: string, token: string) {
    return request(app.getHttpServer()).get(`${API}${path}`).set('authorization', `Bearer ${token}`)
  }

  function patch(path: string, token: string, body: object = {}) {
    return request(app.getHttpServer())
      .patch(`${API}${path}`)
      .set('authorization', `Bearer ${token}`)
      .send(body)
  }

  describe('the default set preserves what staff could already do', () => {
    it.each([
      ['facilities', '/facilities'],
      ['analytics', '/analytics/summary'],
    ])('still admits a default staff member to %s', async (_name, path) => {
      const response = await get(path, staffToken)
      expect(response.status).not.toBe(403)
    })

    it('grants exactly the documented default and nothing more', async () => {
      const membership = await raw.operatorMembership.findFirstOrThrow({
        where: { userId: staff.id, operatorId: operator.id },
      })

      expect([...membership.scopes].sort()).toEqual([...DEFAULT_STAFF_SCOPES].sort())
      // The capabilities a staff member has never had must not arrive by default.
      expect(membership.scopes).not.toContain('org:facility.write')
      expect(membership.scopes).not.toContain('org:member.manage')
    })
  })

  describe('narrowing a member', () => {
    it('refuses the surface whose scope was taken away', async () => {
      await setScopes(staff.id, ['org:scan.execute'])

      await get('/analytics/summary', staffToken).expect(403)
      await get('/facilities', staffToken).expect(403)
    })

    it('leaves the surfaces they kept reachable', async () => {
      await setScopes(staff.id, ['org:facility.read'])

      const response = await get('/facilities', staffToken)
      expect(response.status).not.toBe(403)
    })

    it('never narrows the operator’s own admin, whose set is derived', async () => {
      // Empty column, which is what every ADMIN row actually stores.
      await raw.operatorMembership.updateMany({
        where: { userId: admin.id, operatorId: operator.id },
        data: { scopes: [] },
      })

      const response = await get('/analytics/summary', adminToken)
      expect(response.status).not.toBe(403)
    })
  })

  describe('managing scopes', () => {
    it('lets an operator admin set them, and signs the member out', async () => {
      const before = await raw.user.findUniqueOrThrow({ where: { id: staff.id } })

      const response = await patch(
        `/operators/${operator.id}/members/${staff.id}/scopes`,
        adminToken,
        { scopes: ['org:booking.read', 'org:scan.execute'] },
      ).expect(200)

      expect(response.body.scopes).toEqual(['org:booking.read', 'org:scan.execute'])

      // Narrowing what someone may do has to invalidate the tokens they are holding, or the
      // change does not take effect until their session happens to expire.
      const after = await raw.user.findUniqueOrThrow({ where: { id: staff.id } })
      expect(after.sessionsValidFrom).not.toEqual(before.sessionsValidFrom)
      expect(after.sessionsValidFrom).toBeInstanceOf(Date)
    })

    it('replaces the set wholesale rather than merging', async () => {
      await patch(`/operators/${operator.id}/members/${staff.id}/scopes`, adminToken, {
        scopes: ['org:scan.execute'],
      }).expect(200)

      const membership = await raw.operatorMembership.findFirstOrThrow({
        where: { userId: staff.id, operatorId: operator.id },
      })
      expect(membership.scopes).toEqual(['org:scan.execute'])
    })

    it('refuses to narrow an administrator, who derives every scope', async () => {
      const other = await seedUser(raw, {
        role: UserRole.OPERATOR_ADMIN,
        operatorId: operator.id,
      })

      await patch(`/operators/${operator.id}/members/${other.id}/scopes`, adminToken, {
        scopes: ['org:scan.execute'],
      }).expect(409)
    })

    it('rejects a scope outside the closed set', async () => {
      await patch(`/operators/${operator.id}/members/${staff.id}/scopes`, adminToken, {
        scopes: ['org:everything'],
      }).expect(400)
    })

    it('refuses a staff member who does not manage the team', async () => {
      await patch(`/operators/${operator.id}/members/${staff.id}/scopes`, staffToken, {
        scopes: [...ORG_PERMISSIONS],
      }).expect(403)
    })

    it('reports an administrator’s effective set as the full ten', async () => {
      const members = await get(`/operators/${operator.id}/members`, adminToken).expect(200)

      const adminRow = members.body.find((m: { userId: string }) => m.userId === admin.id)
      expect([...adminRow.scopes].sort()).toEqual([...ORG_PERMISSIONS].sort())
    })
  })
})
