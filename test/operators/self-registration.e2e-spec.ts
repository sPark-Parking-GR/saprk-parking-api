import {
  OperatorStatus,
  PrismaClient,
  UserRole,
  type ParkingOperator,
  type User,
} from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import request from 'supertest'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import { seedOperator, seedUser } from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'
const CENTRE = { lat: 37.9838, lng: 23.7275 }

/**
 * Public operator registration and the PENDING quarantine behind it.
 *
 * The quarantine is the part worth testing hardest. Before self-signup existed, a PENDING
 * operator never had a live administrator — accepting an onboarding invite flips it to
 * VERIFIED in the same transaction — so nothing had ever exercised "an operator with a real
 * admin that sPark has not vouched for". These tests are that state.
 *
 * A SUCCESSFUL registration provisions an identity through the auth provider, which needs
 * Firebase credentials the test environment does not have, so the created-account path is
 * covered by unit tests with a mocked provider. Everything reachable without provisioning —
 * the flag, validation, and the entire quarantine — is exercised here against real HTTP.
 */
describe('operator self-registration over HTTP (e2e)', () => {
  let app: NestFastifyApplication
  let raw: PrismaClient

  let platformAdmin: User
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
    await resetThrottle(app)

    platformAdmin = await seedUser(raw, { role: UserRole.PLATFORM_ADMIN })
    platformToken = bearerToken(platformAdmin)
  })

  function post(path: string, token: string | undefined, body: object = {}) {
    const req = request(app.getHttpServer()).post(`${API}${path}`)
    if (token) req.set('authorization', `Bearer ${token}`)
    return req.send(body)
  }

  /** A BUSINESS facility needs capacity, vehicle types and hours; the schema enforces all. */
  function facilityBody(operatorId: string, name: string) {
    return {
      operatorId,
      name,
      address: 'Somewhere in Athens',
      ...CENTRE,
      totalCapacity: 10,
      onlineQuota: 5,
      vehicleTypes: ['car'],
      openingHours: { is24h: true },
    }
  }

  /** A PENDING operator whose admin is real — the state only self-signup can produce. */
  async function pendingOperatorWithAdmin(): Promise<{ operator: ParkingOperator; token: string }> {
    const operator = await seedOperator(raw)
    await raw.parkingOperator.update({
      where: { id: operator.id },
      data: { status: OperatorStatus.PENDING, verifiedAt: null },
    })
    const admin = await seedUser(raw, {
      role: UserRole.OPERATOR_ADMIN,
      operatorId: operator.id,
    })
    return { operator, token: bearerToken(admin) }
  }

  describe('the flag', () => {
    // The suite runs with the default (unset), which the schema resolves to 'false'.
    it('refuses registration while the platform is invite-only', async () => {
      const response = await post('/auth/register/operator', undefined, {
        email: 'new@spark.invalid',
        password: 'a-strong-password',
        businessName: 'New Parking Ltd',
      }).expect(403)

      expect(response.body.message).toMatch(/invit/i)
      expect(await raw.parkingOperator.count()).toBe(0)
    })

    it('tells the sign-up page it is closed, so it can explain rather than fail on submit', async () => {
      const response = await request(app.getHttpServer())
        .get(`${API}/auth/register/operator/availability`)
        .expect(200)

      expect(response.body).toEqual({ enabled: false })
    })

    it('validates the body before consulting the flag, so errors stay specific', async () => {
      await post('/auth/register/operator', undefined, {
        email: 'not-an-email',
        password: 'short',
        businessName: '',
      }).expect(400)
    })
  })

  /**
   * Every one of these already held before this phase, but none had ever been reachable:
   * they are what makes PENDING a quarantine rather than a label.
   */
  describe('the PENDING quarantine', () => {
    it('refuses to let an unverified business publish a facility', async () => {
      const { operator, token } = await pendingOperatorWithAdmin()

      const response = await post(
        '/facilities',
        token,
        facilityBody(operator.id, 'Unverified Lot'),
      ).expect(409)

      expect(response.body.message).toMatch(/verif/i)
      expect(await raw.facility.count()).toBe(0)
    })

    it('refuses to let it invite staff', async () => {
      const { operator, token } = await pendingOperatorWithAdmin()

      await post('/invites/members', token, {
        email: 'staff@spark.invalid',
        role: 'STAFF',
        operatorId: operator.id,
      }).expect(404)
    })

    it('lets a platform admin verify it, after which both succeed', async () => {
      const { operator, token } = await pendingOperatorWithAdmin()

      await post(`/admin/operators/${operator.id}/verify`, platformToken).expect(204)

      const verified = await raw.parkingOperator.findUniqueOrThrow({ where: { id: operator.id } })
      expect(verified.status).toBe(OperatorStatus.VERIFIED)
      expect(verified.verifiedAt).toBeInstanceOf(Date)

      await post('/facilities', token, facilityBody(operator.id, 'Verified Lot')).expect(201)
    })

    it('records the verification against the operator', async () => {
      const { operator } = await pendingOperatorWithAdmin()

      await post(`/admin/operators/${operator.id}/verify`, platformToken).expect(204)

      const audit = await raw.auditLog.findFirstOrThrow({ where: { action: 'operator.verified' } })
      expect(audit).toMatchObject({ actorId: platformAdmin.id, entityId: operator.id })
    })
  })

  describe('verification', () => {
    it('refuses an operator that is not pending, naming the attempted action', async () => {
      const operator = await seedOperator(raw)

      const response = await post(`/admin/operators/${operator.id}/verify`, platformToken).expect(
        409,
      )

      expect(response.body.message).toMatch(/pending/i)
    })

    it.each([
      ['an operator admin', UserRole.OPERATOR_ADMIN],
      ['a consumer', UserRole.USER],
    ])('refuses %s', async (_name, role) => {
      const { operator } = await pendingOperatorWithAdmin()
      const outsider = await seedUser(raw, { role })

      await post(`/admin/operators/${operator.id}/verify`, bearerToken(outsider)).expect(403)

      const unchanged = await raw.parkingOperator.findUniqueOrThrow({ where: { id: operator.id } })
      expect(unchanged.status).toBe(OperatorStatus.PENDING)
    })

    it('404s an operator that does not exist', async () => {
      await post('/admin/operators/does-not-exist/verify', platformToken).expect(404)
    })
  })
})
