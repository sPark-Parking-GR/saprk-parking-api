import { createHash } from 'crypto'
import { InviteStatus, PrismaClient, UserRole, type User } from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import request from 'supertest'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import { seedOperator, seedUser } from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'
const INVITES = `${API}/admin-invites`

/**
 * Platform administrators recruiting a peer.
 *
 * The property this suite exists to protect is the asymmetry: issuing one of these grants
 * no visibility into any account, including the account it creates. If that ever stopped
 * holding, `identity:admin.invite` would have quietly become account management.
 */
describe('platform admin invites over HTTP (e2e)', () => {
  let app: NestFastifyApplication
  let raw: PrismaClient

  let platformAdmin: User
  let superAdmin: User
  let operatorAdmin: User
  let consumer: User

  let platformToken: string
  let superToken: string
  let operatorToken: string
  let consumerToken: string

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

    const operator = await seedOperator(raw)
    platformAdmin = await seedUser(raw, { role: UserRole.PLATFORM_ADMIN })
    superAdmin = await seedUser(raw, { role: UserRole.SUPER_ADMIN })
    operatorAdmin = await seedUser(raw, {
      role: UserRole.OPERATOR_ADMIN,
      operatorId: operator.id,
    })
    consumer = await seedUser(raw, { role: UserRole.USER })

    platformToken = bearerToken(platformAdmin)
    superToken = bearerToken(superAdmin)
    operatorToken = bearerToken(operatorAdmin)
    consumerToken = bearerToken(consumer)
  })

  function post(path: string, token: string | undefined, body: object = {}) {
    const req = request(app.getHttpServer()).post(`${INVITES}${path}`)
    if (token) req.set('authorization', `Bearer ${token}`)
    return req.send(body)
  }

  function get(path: string, token?: string) {
    const req = request(app.getHttpServer()).get(`${INVITES}${path}`)
    return token ? req.set('authorization', `Bearer ${token}`) : req
  }

  async function issue(token: string, email = 'newadmin@spark.invalid') {
    const response = await post('', token, { email, displayName: 'New Admin' }).expect(201)
    return response.body as { id: string; email: string; status: InviteStatus }
  }

  /**
   * The raw token leaves the system only through the email, by design — it is never in a
   * response and cannot be recovered from the stored sha256. So the test implants a hash it
   * knows the preimage of, which exercises the real accept path (lookup by hash, status and
   * expiry checks, provisioning) without weakening the property that makes the token safe.
   */
  async function implantToken(inviteId: string): Promise<string> {
    const rawToken = `test-token-${inviteId}`
    await raw.platformAdminInvite.update({
      where: { id: inviteId },
      data: { tokenHash: createHash('sha256').update(rawToken).digest('hex') },
    })
    return rawToken
  }

  describe('who may issue one', () => {
    it('admits a platform admin — the one identity capability that tier holds', async () => {
      const invite = await issue(platformToken)

      expect(invite).toMatchObject({
        email: 'newadmin@spark.invalid',
        status: InviteStatus.PENDING,
      })
    })

    it('admits a super admin too', async () => {
      await post('', superToken, { email: 'other@spark.invalid' }).expect(201)
    })

    it.each([
      ['an operator admin', () => operatorToken],
      ['a consumer', () => consumerToken],
    ])('refuses %s', async (_name, token) => {
      await post('', token(), { email: 'nope@spark.invalid' }).expect(403)
      expect(await raw.platformAdminInvite.count()).toBe(0)
    })

    it('refuses an anonymous caller', async () => {
      await post('', undefined, { email: 'nope@spark.invalid' }).expect(401)
    })

    it('rejects a malformed address before writing anything', async () => {
      await post('', platformToken, { email: 'not-an-email' }).expect(400)
      expect(await raw.platformAdminInvite.count()).toBe(0)
    })
  })

  /**
   * The whole point of the tier split, re-asserted here because this phase is the one that
   * hands platform admins an identity permission for the first time.
   */
  describe('issuing one grants no account visibility', () => {
    it('still refuses the inviting platform admin every account route', async () => {
      await issue(platformToken)

      await request(app.getHttpServer())
        .get(`${API}/admin/users`)
        .set('authorization', `Bearer ${platformToken}`)
        .expect(403)
    })

    it('shows a platform admin only the invites they issued themselves', async () => {
      await issue(platformToken, 'mine@spark.invalid')
      await post('', superToken, { email: 'theirs@spark.invalid' }).expect(201)

      const mine = await get('', platformToken).expect(200)
      expect(mine.body.map((i: { email: string }) => i.email)).toEqual(['mine@spark.invalid'])

      // A super admin holds identity:user.read, so the roster is legitimately theirs to see.
      const all = await get('', superToken).expect(200)
      expect(all.body).toHaveLength(2)
    })

    it("404s another admin's invite rather than confirming the id exists", async () => {
      const theirs = await post('', superToken, { email: 'theirs@spark.invalid' }).expect(201)

      await post(`/${theirs.body.id}/revoke`, platformToken).expect(404)
    })
  })

  /**
   * Refusals only. A SUCCESSFUL accept provisions an identity through the auth provider,
   * which talks to Firebase and has no usable credentials here — the same reason no other
   * e2e suite redeems an invite. That path is covered in admin-invite.service.spec.ts with
   * a mocked provider, matching how the operator invite flow is tested.
   */
  describe('redeeming one', () => {
    it('reports the invitee address without a token, for the accept page to render', async () => {
      const invite = await issue(platformToken)
      const token = await implantToken(invite.id)

      const validation = await get(`/token/${token}`).expect(200)
      expect(validation.body).toMatchObject({ email: 'newadmin@spark.invalid', expired: false })
    })

    it('refuses an unknown token', async () => {
      await get('/token/not-a-real-token').expect(404)
      await post('/token/not-a-real-token/accept', undefined, {
        password: 'a-strong-password',
      }).expect(404)
    })

    it('cannot be redeemed after it is revoked', async () => {
      const invite = await issue(platformToken)
      const token = await implantToken(invite.id)

      await post(`/${invite.id}/revoke`, platformToken).expect(200)

      await post(`/token/${token}/accept`, undefined, { password: 'a-strong-password' }).expect(410)
      expect(await raw.user.findUnique({ where: { email: 'newadmin@spark.invalid' } })).toBeNull()
    })

    it('cannot be redeemed after it lapses, and self-heals its status', async () => {
      const invite = await issue(platformToken)
      const token = await implantToken(invite.id)
      await raw.platformAdminInvite.update({
        where: { id: invite.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })

      await post(`/token/${token}/accept`, undefined, { password: 'a-strong-password' }).expect(410)

      const after = await raw.platformAdminInvite.findUniqueOrThrow({ where: { id: invite.id } })
      expect(after.status).toBe(InviteStatus.EXPIRED)
    })

    it('demands a password that sign-in would also accept', async () => {
      const invite = await issue(platformToken)
      const token = await implantToken(invite.id)

      await post(`/token/${token}/accept`, undefined, { password: 'short' }).expect(400)
    })
  })

  /**
   * Promoting an existing account is a role change a super admin makes deliberately. An
   * invitation must never do it as a side effect — the same rule the bootstrap CLI follows.
   */
  describe('an address that already has an account', () => {
    it('is refused at issuance', async () => {
      await post('', platformToken, { email: consumer.email }).expect(409)
      expect(await raw.platformAdminInvite.count()).toBe(0)
    })

    it('is refused at redemption too, if they signed up while the link was live', async () => {
      const invite = await issue(platformToken, 'racer@spark.invalid')
      const token = await implantToken(invite.id)

      await seedUser(raw, { role: UserRole.USER, email: 'racer@spark.invalid' })

      await post(`/token/${token}/accept`, undefined, { password: 'a-strong-password' }).expect(409)

      const unchanged = await raw.user.findUniqueOrThrow({
        where: { email: 'racer@spark.invalid' },
      })
      expect(unchanged.role).toBe(UserRole.USER)
    })
  })

  describe('resend and revoke', () => {
    it('rotates the token on resend, killing the previous link', async () => {
      const invite = await issue(platformToken)
      const before = await raw.platformAdminInvite.findUniqueOrThrow({ where: { id: invite.id } })

      await post(`/${invite.id}/resend`, platformToken).expect(200)

      const after = await raw.platformAdminInvite.findUniqueOrThrow({ where: { id: invite.id } })
      // Overwriting the hash IS the invalidation: the old one no longer exists in the
      // table, so the previous link resolves to nothing.
      expect(after.tokenHash).not.toBe(before.tokenHash)
      expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime())
    })

    it('revokes a pending invite and refuses to revoke it twice', async () => {
      const invite = await issue(platformToken)

      const revoked = await post(`/${invite.id}/revoke`, platformToken).expect(200)
      expect(revoked.body.status).toBe(InviteStatus.REVOKED)

      await post(`/${invite.id}/revoke`, platformToken).expect(409)
    })

    it('refuses to resend or revoke one that was already accepted', async () => {
      const invite = await issue(platformToken)
      await raw.platformAdminInvite.update({
        where: { id: invite.id },
        data: { status: InviteStatus.ACCEPTED, acceptedAt: new Date() },
      })

      await post(`/${invite.id}/resend`, platformToken).expect(409)
      await post(`/${invite.id}/revoke`, platformToken).expect(409)
    })
  })
})
