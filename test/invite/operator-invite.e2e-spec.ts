import { createHash } from 'crypto'
import {
  InviteStatus,
  OperatorInviteKind,
  OperatorMemberRole,
  OperatorStatus,
  PrismaClient,
  UserRole,
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
const INVITES = `${API}/invites`

/**
 * Redeeming an operator invite, over HTTP, for real.
 *
 * This suite could not exist before. Accept provisioned its identity through a
 * directly-constructed FirebaseAuthProvider, bypassing AUTH_PROVIDER entirely, so it always
 * wanted Google credentials the harness does not have — the admin-invite suite says exactly
 * that where it stops at refusals. Provisioning now goes through the configured provider, so
 * under the harness's AUTH_PROVIDER=authjs the whole flow runs against the real container:
 * issue, validate, redeem, and sign in as the account it created.
 *
 * That matters beyond coverage for its own sake. Accept is the single most
 * security-sensitive endpoint in the product — it is unauthenticated, it mints an
 * operator_admin, and it is the only place a token is exchanged for a credential. Every
 * assertion below was previously reachable only by hand.
 */
describe('operator invites over HTTP (e2e)', () => {
  let app: NestFastifyApplication
  let raw: PrismaClient

  let platformAdmin: User
  let operatorAdmin: User
  let consumer: User

  let platformToken: string
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
    operatorAdmin = await seedUser(raw, {
      role: UserRole.OPERATOR_ADMIN,
      operatorId: operator.id,
    })
    consumer = await seedUser(raw, { role: UserRole.USER })

    platformToken = bearerToken(platformAdmin)
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

  async function issue(email = 'new.operator@spark.invalid') {
    const response = await post('', platformToken, { email }).expect(201)
    return response.body as { id: string; email: string; status: InviteStatus }
  }

  /**
   * The raw token leaves the system only through the email — never in a response, and not
   * recoverable from the stored sha256. Implanting a hash whose preimage the test knows
   * exercises the real accept path (lookup by hash, status and expiry checks, provisioning)
   * without weakening the property that makes the token safe. Same device the admin-invite
   * suite uses.
   */
  async function implantToken(inviteId: string): Promise<string> {
    const rawToken = `e2e-operator-token-${inviteId}`
    await raw.operatorInvite.update({
      where: { id: inviteId },
      data: { tokenHash: createHash('sha256').update(rawToken).digest('hex') },
    })
    return rawToken
  }

  describe('issuing one', () => {
    it('is refused to an operator admin — recruiting tenants is the platform’s job', async () => {
      await post('', operatorToken, { email: 'x@spark.invalid' }).expect(403)
    })

    it('is refused to a consumer', async () => {
      await post('', consumerToken, { email: 'x@spark.invalid' }).expect(403)
    })

    it('is refused without a token at all', async () => {
      await post('', undefined, { email: 'x@spark.invalid' }).expect(401)
    })

    it('creates a PENDING onboarding invite and a shell operator to attach it to', async () => {
      const invite = await issue()

      expect(invite).toMatchObject({
        email: 'new.operator@spark.invalid',
        status: InviteStatus.PENDING,
      })

      const stored = await raw.operatorInvite.findUniqueOrThrow({ where: { id: invite.id } })
      expect(stored.kind).toBe(OperatorInviteKind.ONBOARDING)
      expect(stored.role).toBe(OperatorMemberRole.ADMIN)
      // The business has no name until the invitee chooses one at accept; the shell exists
      // only to hold the id the invite points at.
      expect(stored.operatorId).not.toBeNull()
      const shell = await raw.parkingOperator.findUniqueOrThrow({
        where: { id: stored.operatorId as string },
      })
      expect(shell).toMatchObject({ name: '', status: OperatorStatus.PENDING })
    })

    it('never returns the raw token, only its hash is stored', async () => {
      const invite = await issue()

      expect(JSON.stringify(invite)).not.toMatch(/[a-f0-9]{64}/)
      const stored = await raw.operatorInvite.findUniqueOrThrow({ where: { id: invite.id } })
      expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('refuses an address that already has an account, at issue rather than at redeem', async () => {
      await post('', platformToken, { email: consumer.email }).expect(409)
    })
  })

  describe('validating a link before showing the form', () => {
    it('reports the invitee address without requiring a session', async () => {
      const invite = await issue()
      const token = await implantToken(invite.id)

      const response = await get(`/${token}`).expect(200)

      expect(response.body).toMatchObject({
        email: 'new.operator@spark.invalid',
        kind: OperatorInviteKind.ONBOARDING,
        expired: false,
        alreadyAccepted: false,
      })
    })

    it('answers 404 for a token that matches nothing', async () => {
      await get('/not-a-real-token').expect(404)
    })
  })

  describe('redeeming one', () => {
    // Not async: supertest's chainable `.expect` lives on the request, and awaiting it
    // first would hand back a plain response.
    function redeem(token: string, body: object = {}) {
      return post(`/${token}/accept`, undefined, {
        password: 'e2e-operator-password',
        businessName: 'E2E Parking SA',
        displayName: 'Eleni Nikolaou',
        ...body,
      })
    }

    /**
     * The whole point of the suite. Every assertion here is on the state accept leaves
     * behind, because that state is what the operator's first session depends on.
     */
    it('provisions the account, attaches it to the operator and returns a usable session', async () => {
      const invite = await issue()
      const token = await implantToken(invite.id)

      const response = await redeem(token).expect(200)

      const body = response.body as {
        session: { accessToken: string; refreshToken: string; user: { id: string; role: string } }
      }
      expect(body.session.user.role).toBe('operator_admin')
      expect(body.session.accessToken).toBeTruthy()

      const account = await raw.user.findUniqueOrThrow({ where: { id: body.session.user.id } })
      // Created through the CONFIGURED provider: the harness runs AUTH_PROVIDER=authjs, so
      // the credential is a local scrypt hash and there is no remote identity. Before, this
      // row would have carried a firebaseUid and an empty hash no matter what the env said.
      expect(account.firebaseUid).toBeNull()
      expect(account.passwordHash).not.toBe('')
      expect(account.email).toBe('new.operator@spark.invalid')
      // The person's own name — the business name goes to the operator, not here.
      expect(account.displayName).toBe('Eleni Nikolaou')

      const membership = await raw.operatorMembership.findFirstOrThrow({
        where: { userId: account.id },
      })
      expect(membership.role).toBe(OperatorMemberRole.ADMIN)
      // An admin stores no scopes: their set is derived, so a scope added later applies.
      expect(membership.scopes).toEqual([])

      const operator = await raw.parkingOperator.findUniqueOrThrow({
        where: { id: membership.operatorId },
      })
      expect(operator).toMatchObject({
        name: 'E2E Parking SA',
        status: OperatorStatus.VERIFIED,
      })

      const redeemed = await raw.operatorInvite.findUniqueOrThrow({ where: { id: invite.id } })
      expect(redeemed.status).toBe(InviteStatus.ACCEPTED)
      expect(redeemed.acceptedAt).not.toBeNull()
    })

    it('issues a session the running AuthGuard actually accepts', async () => {
      const invite = await issue()
      const token = await implantToken(invite.id)
      const response = await redeem(token).expect(200)
      const { accessToken } = (response.body as { session: { accessToken: string } }).session

      // The end of the flow that matters to a real operator: they land on the dashboard and
      // it loads. A token that verifies nowhere would still have passed every check above.
      await request(app.getHttpServer())
        .get(`${API}/facilities`)
        .set('authorization', `Bearer ${accessToken}`)
        .expect(200)
    })

    it('lets the new operator sign in afterwards with the password they chose', async () => {
      const invite = await issue()
      const token = await implantToken(invite.id)
      await redeem(token).expect(200)

      await request(app.getHttpServer())
        .post(`${API}/auth/sign-in`)
        .send({ email: 'new.operator@spark.invalid', password: 'e2e-operator-password' })
        .expect(200)
    })

    it('refuses to be redeemed twice, and says which of the two 409s it is', async () => {
      const invite = await issue()
      const token = await implantToken(invite.id)
      await redeem(token).expect(200)

      const second = await redeem(token).expect(409)
      // Distinct from EMAIL_TAKEN: the accept page renders "already set up, sign in" rather
      // than "that address is registered", which are opposite remedies.
      expect((second.body as { code?: string }).code).toBeUndefined()

      const validated = await get(`/${token}`).expect(200)
      expect(validated.body).toMatchObject({ expired: true, alreadyAccepted: true })
    })

    it('refuses a revoked invite with 410, leaving no account behind', async () => {
      const invite = await issue()
      const token = await implantToken(invite.id)
      await post(`/${invite.id}/revoke`, platformToken).expect(204)

      await redeem(token).expect(410)

      expect(
        await raw.user.findFirst({ where: { email: 'new.operator@spark.invalid' } }),
      ).toBeNull()
    })

    it('refuses an expired invite with 410 and records it as EXPIRED', async () => {
      const invite = await issue()
      const token = await implantToken(invite.id)
      await raw.operatorInvite.update({
        where: { id: invite.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })

      await redeem(token).expect(410)

      const stored = await raw.operatorInvite.findUniqueOrThrow({ where: { id: invite.id } })
      expect(stored.status).toBe(InviteStatus.EXPIRED)
    })

    it('demands a business name, and provisions nothing without one', async () => {
      const invite = await issue()
      const token = await implantToken(invite.id)

      await redeem(token, { businessName: undefined }).expect(400)

      expect(
        await raw.user.findFirst({ where: { email: 'new.operator@spark.invalid' } }),
      ).toBeNull()
      const stored = await raw.operatorInvite.findUniqueOrThrow({ where: { id: invite.id } })
      expect(stored.status).toBe(InviteStatus.PENDING)
    })

    it('demands a password sign-in would also accept', async () => {
      const invite = await issue()
      const token = await implantToken(invite.id)

      await redeem(token, { password: 'short' }).expect(400)
    })

    it('answers 404 for a token that matches nothing, without saying why', async () => {
      await post('/not-a-real-token/accept', undefined, {
        password: 'e2e-operator-password',
        businessName: 'E2E Parking SA',
        displayName: 'Eleni Nikolaou',
      }).expect(404)
    })
  })

  describe('re-inviting the same address', () => {
    it('supersedes the previous invite so only one link is ever redeemable', async () => {
      const first = await issue()
      const firstToken = await implantToken(first.id)
      const second = await issue()

      expect(second.id).not.toBe(first.id)
      const superseded = await raw.operatorInvite.findUniqueOrThrow({ where: { id: first.id } })
      expect(superseded.status).toBe(InviteStatus.REVOKED)

      await post(`/${firstToken}/accept`, undefined, {
        password: 'e2e-operator-password',
        businessName: 'E2E Parking SA',
        displayName: 'Eleni Nikolaou',
      }).expect(410)
    })
  })
})
