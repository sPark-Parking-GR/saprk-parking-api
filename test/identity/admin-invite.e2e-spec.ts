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
    it('is refused at issuance when the address already holds a privileged role', async () => {
      await post('', platformToken, { email: operatorAdmin.email }).expect(409)
      expect(await raw.platformAdminInvite.count()).toBe(0)
    })

    // Issuance never needs ownership proof, only redemption does — a mobile-only address
    // is who will end up redeeming it, by proving they own it with its own password.
    it('does not refuse issuance to a mobile-only account — that email attaches at redeem', async () => {
      await post('', platformToken, { email: consumer.email }).expect(201)
    })

    // The seeded racer has no real credential (seedUser writes no passwordHash), so this
    // exercises the wrong-password collapse below rather than a blanket existence refusal
    // — any password attempt against an account whose real password is unknown fails the
    // same way a genuinely-taken address does.
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

  describe('redeeming into an existing mobile-only account', () => {
    function redeem(token: string, body: object = {}) {
      return post(`/token/${token}/accept`, undefined, { password: 'e2e-driver-password', ...body })
    }

    async function signUpConsumer(email: string, password: string): Promise<{ accessToken: string }> {
      const response = await request(app.getHttpServer())
        .post(`${API}/auth/sign-up`)
        .send({ email, password, displayName: 'Driver Person' })
        .expect(201)
      return (response.body as { session: { accessToken: string } }).session
    }

    it('attaches the invite to the existing account instead of creating a second one', async () => {
      const email = 'driver.turned.admin@spark.invalid'
      const password = 'e2e-driver-password'
      await signUpConsumer(email, password)

      const invite = await issue(platformToken, email)
      const token = await implantToken(invite.id)

      const response = await redeem(token, { password }).expect(200)
      expect(response.body).toEqual({ linked: true })

      const accounts = await raw.user.findMany({ where: { email } })
      expect(accounts).toHaveLength(1)
      expect(accounts[0]?.role).toBe(UserRole.PLATFORM_ADMIN)
    })

    it('revokes the account’s prior mobile session the instant it is attached', async () => {
      const email = 'driver.session.revoked.admin@spark.invalid'
      const password = 'e2e-driver-password'
      const priorSession = await signUpConsumer(email, password)

      const invite = await issue(platformToken, email)
      const token = await implantToken(invite.id)
      await redeem(token, { password }).expect(200)

      await request(app.getHttpServer())
        .get(`${API}/facilities`)
        .set('authorization', `Bearer ${priorSession.accessToken}`)
        .expect(401)
    })

    it('lets the linked account sign in fresh afterwards with its unchanged password', async () => {
      const email = 'driver.signs.in.after.admin@spark.invalid'
      const password = 'e2e-driver-password'
      await signUpConsumer(email, password)

      const invite = await issue(platformToken, email)
      const token = await implantToken(invite.id)
      await redeem(token, { password }).expect(200)

      const signIn = await request(app.getHttpServer())
        .post(`${API}/auth/sign-in`)
        .send({ email, password })
        .expect(200)
      expect((signIn.body as { session: { user: { role: string } } }).session.user.role).toBe(
        'platform_admin',
      )
    })

    it('refuses the wrong password with the same conflict a taken address gets, attaching nothing', async () => {
      const email = 'driver.wrong.password.admin@spark.invalid'
      await signUpConsumer(email, 'e2e-driver-password')

      const invite = await issue(platformToken, email)
      const token = await implantToken(invite.id)

      await redeem(token, { password: 'not-the-right-password' }).expect(409)

      const account = await raw.user.findUniqueOrThrow({ where: { email } })
      expect(account.role).toBe(UserRole.USER)
    })
  })

  describe('re-inviting the same address', () => {
    // Without this, revoking the invite an admin can see in the UI does not actually
    // withdraw platform_admin from that address if a different admin also invited it —
    // the invite `list()` scopes each platform admin to only what they themselves issued.
    it('supersedes the previous invite so only one link is ever redeemable', async () => {
      const first = await issue(platformToken, 'contested@spark.invalid')
      const firstToken = await implantToken(first.id)
      const second = await issue(platformToken, 'contested@spark.invalid')

      expect(second.id).not.toBe(first.id)
      const superseded = await raw.platformAdminInvite.findUniqueOrThrow({
        where: { id: first.id },
      })
      expect(superseded.status).toBe(InviteStatus.REVOKED)

      await post(`/token/${firstToken}/accept`, undefined, {
        password: 'a-strong-password',
      }).expect(410)
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
