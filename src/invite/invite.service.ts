import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { AuthContext } from '@spark/auth'
import {
  DEFAULT_STAFF_SCOPES,
  hasPlatformPermission,
  isPlatformRole,
  type AuthResult,
  type AuthUser,
  type UserRole,
} from '@spark/types'
import {
  InviteStatus,
  OperatorInviteKind,
  OperatorMemberRole,
  OperatorStatus,
  type Prisma,
} from '@prisma/client'
import { AccountLinkingService } from '../auth/account-linking.service'
import { AUTH_CONTEXT_TOKEN } from '../auth/auth.constants'
import { TO_PRISMA } from '../auth/authjs-user.store'
import { RequestContext } from '../common/context/request-context'
import { OperatorSuspendedError } from '../common/errors/domain.errors'
import { NotificationsService } from '../notifications/notifications.service'
import { OperatorAccessService } from '../operators/operator-access.service'
import { OperatorNotFoundError } from '../operators/operators.types'
import { PrismaService } from '../prisma/prisma.service'
import { EntitlementService } from '../subscriptions/entitlement.service'
import { QuotaThresholdService } from '../subscriptions/quota-threshold.service'
import { InviteTokenService } from './invite-token.service'
import type { CreateInviteDto, CreateMemberInviteDto } from './dto/invite.dto'
import {
  InviteAlreadyAcceptedError,
  InviteBusinessNameRequiredError,
  InviteEmailTakenError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteNotResendableError,
  InviteNotRevocableError,
  type InviteIssued,
  type InviteSummary,
  type InviteValidation,
} from './invite.types'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const RESENDABLE_STATUSES: InviteStatus[] = [InviteStatus.PENDING, InviteStatus.EXPIRED]

type GrantedRole = Extract<UserRole, 'operator_admin' | 'operator_staff'>

function userRoleFor(memberRole: OperatorMemberRole): GrantedRole {
  return memberRole === OperatorMemberRole.ADMIN ? 'operator_admin' : 'operator_staff'
}

@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    private readonly access: OperatorAccessService,
    private readonly entitlements: EntitlementService,
    private readonly quotaThresholds: QuotaThresholdService,
    private readonly tokens: InviteTokenService,
    // The CONFIGURED provider, not a directly-constructed Firebase one. Provisioning used
    // to bypass AUTH_PROVIDER entirely, so every invited account was Firebase-backed
    // whatever the deployment had selected — which is both the strategy-pattern violation
    // CLAUDE.md forbids and the reason no e2e suite could ever redeem an invite.
    @Inject(AUTH_CONTEXT_TOKEN) private readonly auth: AuthContext,
    private readonly accountLinking: AccountLinkingService,
  ) {}

  async create(actor: AuthUser, dto: CreateInviteDto): Promise<InviteIssued> {
    // Controller already gates on @RequirePermission('platform:role.grant'); re-check in
    // the service layer per the both-layers authorization rule.
    if (!hasPlatformPermission(actor.role, 'platform:role.grant')) {
      throw new ForbiddenException('Only platform admins may issue operator invites')
    }

    const email = dto.email.toLowerCase()
    // Issuance never needs ownership proof — only redemption (accept()) does. An address
    // that already has a mobile-only account may still be invited; that account is who
    // will end up redeeming it, by proving they own it with its own password.
    if ((await this.accountLinking.resolve(email)).kind === 'taken') {
      throw new InviteEmailTakenError(email)
    }

    const { rawToken, tokenHash, expiresAt } = this.mintToken()

    const invite = await this.prisma.$transaction(async (tx) => {
      await this.supersede(tx, actor, {
        email,
        kind: OperatorInviteKind.ONBOARDING,
        status: InviteStatus.PENDING,
      })
      // The business itself has no name yet — the invitee chooses one when they accept,
      // alongside their password. This shell exists only to hold the id the invite points
      // at and the PENDING status accept() flips to VERIFIED.
      const operator = await tx.parkingOperator.create({
        data: { name: '', status: OperatorStatus.PENDING },
      })
      const created = await tx.operatorInvite.create({
        data: {
          email,
          businessName: '',
          operatorId: operator.id,
          kind: OperatorInviteKind.ONBOARDING,
          role: OperatorMemberRole.ADMIN,
          tokenHash,
          invitedById: actor.id,
          expiresAt,
        },
      })
      await this.recordAudit(tx, actor, 'invite.created', created.id, {
        operatorId: operator.id,
        kind: OperatorInviteKind.ONBOARDING,
        role: OperatorMemberRole.ADMIN,
      })
      return created
    })

    const delivered = await this.notifications.sendOperatorInvite({
      to: email,
      acceptUrl: this.acceptUrl(rawToken),
    })

    return { ...this.toSummary(invite), delivered }
  }

  /**
   * The second flow through OperatorInvite: attach a person to an operator that ALREADY
   * exists, rather than minting one. This is the only way an OperatorMembership with role
   * STAFF — and therefore a UserRole.OPERATOR_STAFF account — can come into being.
   */
  async createMember(actor: AuthUser, dto: CreateMemberInviteDto): Promise<InviteIssued> {
    // Controller already gates on @Roles('operator_admin', 'platform_admin'); re-check in
    // the service layer per the both-layers authorization rule.
    if (actor.role !== 'operator_admin' && !isPlatformRole(actor.role)) {
      throw new ForbiddenException('Only operator admins may invite operator members')
    }
    const operatorId = await this.access.resolveAdministrable(actor, dto.operatorId)

    const operator = await this.prisma.parkingOperator.findUnique({
      where: { id: operatorId },
      select: { name: true, status: true },
    })
    if (!operator) throw new OperatorNotFoundError(operatorId)
    if (operator.status === OperatorStatus.SUSPENDED) throw new OperatorSuspendedError()
    // A PENDING operator is an unclaimed onboarding shell whose own admin has not accepted
    // yet; it has no members and must gain its first one through the onboarding invite.
    if (operator.status !== OperatorStatus.VERIFIED) throw new OperatorNotFoundError(operatorId)

    const email = dto.email.toLowerCase()
    // See create(): issuance never needs ownership proof, only redemption does.
    if ((await this.accountLinking.resolve(email)).kind === 'taken') {
      throw new InviteEmailTakenError(email)
    }

    const { rawToken, tokenHash, expiresAt } = this.mintToken()

    const invite = await this.prisma.$transaction(async (tx) => {
      // Seats are checked at ISSUANCE, not at accept: a link that cannot be redeemed is
      // worse than a refusal the inviting admin sees immediately, and counting unredeemed
      // invites against the quota is what stops an operator on two seats from mailing out
      // twenty. Under the same operator-row lock the other quota paths take.
      await tx.$executeRaw`SELECT id FROM "ParkingOperator" WHERE id = ${operatorId} FOR UPDATE`
      // Under the lock and BEFORE the seat check, so re-inviting an address the operator
      // already has a live invite out to costs the seat it already spent, not a second one.
      await this.supersede(tx, actor, {
        email,
        kind: OperatorInviteKind.MEMBER,
        operatorId,
        status: InviteStatus.PENDING,
      })
      await this.entitlements.assertCanAddStaffSeat(operatorId, tx)

      const created = await tx.operatorInvite.create({
        data: {
          email,
          businessName: operator.name,
          operatorId,
          kind: OperatorInviteKind.MEMBER,
          role: dto.role,
          tokenHash,
          invitedById: actor.id,
          expiresAt,
        },
      })
      await this.recordAudit(tx, actor, 'invite.created', created.id, {
        operatorId,
        kind: OperatorInviteKind.MEMBER,
        role: dto.role,
      })
      return created
    })

    const delivered = await this.notifications.sendOperatorMemberInvite({
      to: email,
      businessName: operator.name,
      acceptUrl: this.acceptUrl(rawToken),
      isAdmin: dto.role === OperatorMemberRole.ADMIN,
    })

    // A pending invite already consumes a seat, so the threshold moves here rather than at
    // accept. Same after-commit placement as the invite mail above, and never throws — see
    // QuotaThresholdService.
    await this.quotaThresholds.checkOperatorQuotaThresholds(operatorId)

    return { ...this.toSummary(invite), delivered }
  }

  /**
   * Rotates the token and re-sends, because the raw token has exactly one exit from the
   * system — the email — and a delivery failure otherwise leaves an invite nobody can ever
   * accept. Overwriting tokenHash IS the invalidation: the previous hash no longer exists
   * in the table, so the old link resolves to nothing.
   */
  async resend(actor: AuthUser, id: string): Promise<InviteIssued> {
    const invite = await this.prisma.operatorInvite.findUnique({ where: { id } })
    if (!invite) throw new InviteNotFoundError()

    await this.assertMayIssue(actor, invite)

    if (invite.status === InviteStatus.ACCEPTED) throw new InviteAlreadyAcceptedError()
    if (!RESENDABLE_STATUSES.includes(invite.status)) {
      throw new InviteNotResendableError(invite.status)
    }

    // The expiry is reset, not inherited. A resend exists because the first link never
    // usably arrived, and handing out a replacement that dies in an hour — or is already
    // dead — recreates the failure it is meant to fix. Reviving a lapsed invite is also
    // what keeps the onboarding flow honest: issuing a fresh one instead would create a
    // second shell ParkingOperator for the same business. The grant stays single-use,
    // revocable, and no longer-lived than a brand-new invite.
    const { rawToken, tokenHash, expiresAt } = this.mintToken()

    // Reviving a MEMBER invite that is not currently live is an ISSUANCE, and has to pay for
    // a seat like one. countStaffSeats counts only PENDING invites that have not lapsed, so
    // an EXPIRED — or PENDING-but-lapsed — invite costs nothing while it sits there and
    // would become a redeemable seat the moment this rotates it back to PENDING. accept()
    // performs no seat check by design, so an unpaid seat here is an unpaid seat forever.
    // A still-live invite already occupies its seat: asserting for it would count the very
    // invite being resent and refuse an operator exactly at their limit.
    const revivesASeat =
      invite.kind === OperatorInviteKind.MEMBER &&
      invite.operatorId !== null &&
      !(invite.status === InviteStatus.PENDING && invite.expiresAt > new Date())

    await this.prisma.$transaction(async (tx) => {
      if (revivesASeat) {
        const operatorId = invite.operatorId as string
        // Same lock the create paths take, and for the same reason: it is the only thing
        // serialising two concurrent issuances against one quota.
        await tx.$executeRaw`SELECT id FROM "ParkingOperator" WHERE id = ${operatorId} FOR UPDATE`
        // createMember refuses to issue into an operator that is not VERIFIED; a resend is
        // the same act and must not be the way around that.
        const operator = await tx.parkingOperator.findUnique({
          where: { id: operatorId },
          select: { status: true },
        })
        if (!operator || operator.status !== OperatorStatus.VERIFIED) {
          throw new OperatorNotFoundError(operatorId)
        }
        await this.entitlements.assertCanAddStaffSeat(operatorId, tx)
      }

      // Conditional on the hash that was read: if a concurrent resend already rotated the
      // token, this one must not overwrite the link that request emailed.
      const { count } = await tx.operatorInvite.updateMany({
        where: { id, tokenHash: invite.tokenHash, status: { in: RESENDABLE_STATUSES } },
        data: { tokenHash, expiresAt, status: InviteStatus.PENDING },
      })
      if (count === 0) throw new InviteNotResendableError(invite.status)

      await this.recordAudit(tx, actor, 'invite.resent', id, {
        operatorId: invite.operatorId,
        kind: invite.kind,
        role: invite.role,
      })
    })

    const acceptUrl = this.acceptUrl(rawToken)
    const delivered =
      invite.kind === OperatorInviteKind.MEMBER
        ? await this.notifications.sendOperatorMemberInvite({
            to: invite.email,
            businessName: invite.businessName,
            acceptUrl,
            isAdmin: invite.role === OperatorMemberRole.ADMIN,
          })
        : await this.notifications.sendOperatorInvite({
            to: invite.email,
            acceptUrl,
          })

    return {
      ...this.toSummary({ ...invite, status: InviteStatus.PENDING, expiresAt }),
      delivered,
    }
  }

  async list(actor: AuthUser): Promise<InviteSummary[]> {
    // Controller already gates on @Roles(...); re-check in the service layer per the
    // both-layers authorization rule.
    if (!isPlatformRole(actor.role) && actor.role !== 'operator_admin') {
      throw new ForbiddenException('Only platform and operator admins may view operator invites')
    }

    const administrable = await this.access.administrableOperatorIds(actor)

    const invites = await this.prisma.operatorInvite.findMany({
      // A scoped caller sees only the member invites of operators they admin; onboarding
      // invites are platform business and stay out of the tenant's view even when they
      // point at that tenant's own operator row.
      ...(administrable === null
        ? {}
        : {
            where: {
              operatorId: { in: administrable },
              kind: OperatorInviteKind.MEMBER,
            },
          }),
      orderBy: { createdAt: 'desc' },
    })
    return invites.map((invite) => this.toSummary(invite))
  }

  async revoke(actor: AuthUser, id: string): Promise<void> {
    const invite = await this.prisma.operatorInvite.findUnique({
      where: { id },
      select: { kind: true, operatorId: true },
    })
    if (!invite) throw new InviteNotFoundError()

    await this.assertMayIssue(actor, invite)

    // Conditional update on status is the concurrency guard: a racing accept() either
    // wins (count 0 here) or loses (its own status check already passed, but this row
    // is REVOKED before it commits) — no explicit row lock needed.
    const { count } = await this.prisma.operatorInvite.updateMany({
      where: { id, status: InviteStatus.PENDING },
      data: { status: InviteStatus.REVOKED },
    })

    if (count === 0) {
      const existing = await this.prisma.operatorInvite.findUnique({
        where: { id },
        select: { status: true },
      })
      if (!existing) throw new InviteNotFoundError()
      if (existing.status === InviteStatus.ACCEPTED) throw new InviteAlreadyAcceptedError()
      throw new InviteNotRevocableError(existing.status)
    }

    // Not wrapped in the same transaction as the conditional update above: that update
    // must commit on its own, immediately, for the accept-vs-revoke race documented above
    // to resolve correctly. This audit write is best-effort alongside it, not atomic with it.
    await this.recordAudit(this.prisma, actor, 'invite.revoked', id)

    // Only an onboarding invite owns a shell operator. The check keys off the recorded
    // kind, never off the operator's status, so a member invite can never reach this
    // delete no matter what state its (long-lived, shared) operator happens to be in.
    if (invite.kind !== OperatorInviteKind.ONBOARDING) return

    const revoked = await this.prisma.operatorInvite.findUnique({
      where: { id },
      select: { operatorId: true, operator: { select: { status: true } } },
    })

    // The shell operator created at invite time was never claimed — no user, membership
    // or facility points at it — so it goes away with the invite. Deleting it also
    // cascade-deletes this invite row itself (OperatorInvite.operator onDelete: Cascade),
    // which is why the REVOKED write above must happen first: a racing accept() must see
    // a non-PENDING invite even in the instant before the cascade lands.
    if (revoked?.operatorId && revoked.operator?.status === OperatorStatus.PENDING) {
      await this.prisma.parkingOperator.delete({ where: { id: revoked.operatorId } })
    }
  }

  async validate(token: string): Promise<InviteValidation> {
    const invite = await this.prisma.operatorInvite.findUnique({
      where: { tokenHash: this.hashToken(token) },
      select: {
        businessName: true,
        email: true,
        status: true,
        expiresAt: true,
        role: true,
        kind: true,
      },
    })
    if (!invite) throw new InviteNotFoundError()

    const resolution = await this.accountLinking.resolve(invite.email)

    return {
      businessName: invite.businessName,
      email: invite.email,
      role: invite.role,
      kind: invite.kind,
      expired: invite.status !== InviteStatus.PENDING || invite.expiresAt < new Date(),
      alreadyAccepted: invite.status === InviteStatus.ACCEPTED,
      requiresExistingPassword: resolution.kind === 'linkable',
    }
  }

  async accept(
    token: string,
    password: string,
    businessName?: string,
    displayName?: string,
  ): Promise<AuthResult | { linked: true }> {
    const invite = await this.prisma.operatorInvite.findUnique({
      where: { tokenHash: this.hashToken(token) },
    })
    if (!invite) throw new InviteNotFoundError()
    if (invite.status === InviteStatus.ACCEPTED) throw new InviteAlreadyAcceptedError()

    if (
      invite.status !== InviteStatus.PENDING ||
      invite.expiresAt < new Date() ||
      !invite.operatorId
    ) {
      // Self-heal a lapsed-but-still-PENDING invite so its state reflects reality.
      if (invite.status === InviteStatus.PENDING) {
        await this.prisma.operatorInvite.update({
          where: { id: invite.id },
          data: { status: InviteStatus.EXPIRED },
        })
      }
      throw new InviteExpiredError()
    }

    // Narrowed to a local const: TS won't retain the `invite.operatorId` non-null
    // narrowing across the `await` below (property narrowing doesn't survive a call).
    const operatorId = invite.operatorId
    const isOnboarding = invite.kind === OperatorInviteKind.ONBOARDING

    // Only onboarding collects a business name here — a member invite attaches to an
    // operator that already has one. Checked before Firebase signUp so a missing name
    // never provisions an identity it can't finish attaching.
    const resolvedBusinessName = isOnboarding ? this.requireBusinessName(businessName) : undefined

    // A member invite points at an operator that has been live in the meantime and may
    // have been suspended or unverified since; a tenant in either state must not gain
    // people. The onboarding flow skips this — flipping PENDING to VERIFIED is its job.
    if (!isOnboarding) {
      const operator = await this.prisma.parkingOperator.findUnique({
        where: { id: operatorId },
        select: { status: true },
      })
      if (operator?.status !== OperatorStatus.VERIFIED) throw new InviteExpiredError()
    }

    // Re-checked at redemption, not only at issuance: the address may have changed state
    // during the seven days the link was live. `free` proceeds to signUp as before;
    // `linkable` attaches to the existing mobile-only account instead of colliding with it;
    // `taken` is genuinely gone.
    const resolution = await this.accountLinking.resolve(invite.email)
    if (resolution.kind === 'taken') throw new InviteEmailTakenError(invite.email)
    const isLinking = resolution.kind === 'linkable'

    // The privileges come off the invite, decided and authorized when it was issued. The
    // person redeeming the link never gets a say in them.
    const grantedRole = userRoleFor(invite.role)

    let newUserId: string
    let authResult: AuthResult | undefined
    if (isLinking) {
      // Proves the redeemer actually owns this account before any privilege is granted on
      // its behalf. A wrong password collapses into the SAME error as a genuinely-taken
      // address, deliberately: letting a failed guess read differently from "taken" would
      // turn accept() into an oracle telling an attacker holding the invite token which
      // emails are low-privilege driver accounts ripe for escalation, distinct from ones
      // already spoken for. A correct guess is the only thing anyone is allowed to learn
      // anything from.
      try {
        await this.accountLinking.verifyOwnership(invite.email, password)
      } catch {
        throw new InviteEmailTakenError(invite.email)
      }
      newUserId = resolution.userId
    } else {
      // Creates the Firebase identity AND the local User row; session.user.id is the
      // local Postgres id.
      authResult = await this.auth.signUp({
        email: invite.email,
        password,
        // The person's own name. This used to be the BUSINESS name on the onboarding flow,
        // which made an operator admin show up as their company in every list that names a
        // human — and left member invites with no name at all. The business name belongs to
        // the operator record, which is where it is now written and nowhere else.
        ...(displayName ? { displayName } : {}),
        role: grantedRole,
      })
      newUserId = authResult.session.user.id
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        if (isLinking) {
          // Locked first, before any membership or operator write: nothing else serializes
          // two concurrent redemptions (e.g. two distinct invites) landing on the same
          // linkable address the way the `User.email` unique index serializes two `signUp`s.
          await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${newUserId} FOR UPDATE`
          const locked = await tx.user.findUnique({
            where: { id: newUserId },
            select: {
              role: true,
              lifecycleStatus: true,
              operatorMemberships: { select: { id: true }, take: 1 },
            },
          })
          if (
            locked?.role !== 'USER' ||
            locked.lifecycleStatus !== 'ACTIVE' ||
            locked.operatorMemberships.length !== 0
          ) {
            throw new InviteEmailTakenError(invite.email)
          }
        }

        await tx.operatorMembership.create({
          data: {
            operatorId,
            userId: newUserId,
            role: invite.role,
            // A new staff member starts with the same default set the scopes migration
            // backfilled onto existing ones. Without this the backfill would only ever have
            // helped accounts that predated it, and everyone invited afterwards would
            // arrive able to do nothing. ADMIN stores none and derives all.
            scopes: invite.role === OperatorMemberRole.STAFF ? [...DEFAULT_STAFF_SCOPES] : [],
          },
        })
        if (isOnboarding) {
          await tx.parkingOperator.update({
            where: { id: operatorId },
            data: {
              name: resolvedBusinessName!,
              status: OperatorStatus.VERIFIED,
              verifiedAt: new Date(),
            },
          })
        }
        await tx.user.update({
          where: { id: newUserId },
          data: {
            emailVerified: true,
            // A role grant is a privilege change like any other in this codebase (see
            // identity.service.ts, operator-members.service.ts) and must bump the
            // revocation watermark: without it, a still-live mobile session token for this
            // account becomes a valid operator_admin/staff token the instant this commits.
            ...(isLinking
              ? { role: TO_PRISMA[grantedRole], sessionsValidFrom: new Date() }
              : {}),
          },
        })

        // Conditional on the very token that was redeemed: a revoke or a resend that
        // landed while the identity was being provisioned must beat this accept, and the
        // failed count rolls the whole attachment back (and the identity with it).
        const { count } = await tx.operatorInvite.updateMany({
          where: { id: invite.id, tokenHash: invite.tokenHash, status: InviteStatus.PENDING },
          data: {
            status: InviteStatus.ACCEPTED,
            acceptedAt: new Date(),
            ...(isOnboarding ? { businessName: resolvedBusinessName! } : {}),
          },
        })
        if (count === 0) throw new InviteExpiredError()

        await this.recordAudit(
          tx,
          { id: newUserId, role: grantedRole },
          'invite.accepted',
          invite.id,
          { operatorId, kind: invite.kind, role: invite.role },
        )
      })
    } catch (error) {
      // Firebase and Postgres cannot share one atomic transaction, so a failure after a
      // FRESH identity is created must be compensated by deleting that identity — otherwise
      // an orphaned Firebase+local user with no operator attachment is left behind. A
      // linked account predates this request and is not this request's to destroy, even on
      // failure — the compensating delete only ever applies to the `!isLinking` branch.
      if (!isLinking) {
        try {
          await this.auth.deleteUser(newUserId)
        } catch (cleanupError) {
          this.logger.error(
            `Failed to roll back orphaned identity ${newUserId} after invite-accept failure: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          )
        }
      }
      throw error
    }

    // Not re-minted here on purpose: the transaction above just bumped
    // sessionsValidFrom, and a token issued in that same instant risks landing in the
    // same whole second as the watermark — dead on arrival under the fail-closed
    // tie-break in packages/auth/src/revocation.ts. The caller already knows this
    // password; they sign in themselves, afterward.
    if (isLinking) return { linked: true }

    return authResult!
  }


  /**
   * Retires every live invite the new one replaces, so one address never holds more than a
   * single redeemable link at a time.
   *
   * Without this, issuing a replacement leaves the earlier link working: an admin who
   * revokes the invite they can see in the UI has not actually withdrawn the grant, and a
   * recipient looking at a mailbox of identical-looking invitations has no way to tell
   * which one is current. Tokens were already unique per row; what was missing was that
   * only the newest is valid.
   */
  private async supersede(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    where: Prisma.OperatorInviteWhereInput & { email: string },
  ): Promise<void> {
    const stale = await tx.operatorInvite.findMany({
      where,
      select: { id: true, operatorId: true },
    })
    if (stale.length === 0) return

    const ids = stale.map((invite) => invite.id)
    await tx.operatorInvite.updateMany({
      where: { id: { in: ids }, status: InviteStatus.PENDING },
      data: { status: InviteStatus.REVOKED },
    })

    // The same unclaimed-shell cleanup revoke() performs, and guarded harder because this
    // deletes a set rather than one named row: only an operator still PENDING with no
    // members and no facilities was minted by an invite and never claimed.
    const shellIds = stale
      .map((invite) => invite.operatorId)
      .filter((id): id is string => id !== null)
    if (shellIds.length > 0) {
      await tx.parkingOperator.deleteMany({
        where: {
          id: { in: shellIds },
          status: OperatorStatus.PENDING,
          memberships: { none: {} },
          facilities: { none: {} },
        },
      })
    }

    for (const id of ids) {
      await this.recordAudit(tx, actor, 'invite.superseded', id)
    }
  }

  /** Whoever may create an invite of this shape may also resend or revoke that invite. */
  private async assertMayIssue(
    actor: AuthUser,
    invite: { kind: OperatorInviteKind; operatorId: string | null },
  ): Promise<void> {
    if (invite.kind === OperatorInviteKind.MEMBER) {
      if (actor.role !== 'operator_admin' && !isPlatformRole(actor.role)) {
        throw new ForbiddenException('Only operator admins may manage operator member invites')
      }
      // An operator that was deleted out from under the invite leaves nobody who could
      // still be said to own it.
      if (!invite.operatorId) throw new InviteNotFoundError()
      await this.access.resolveAdministrable(actor, invite.operatorId)
      return
    }

    if (!hasPlatformPermission(actor.role, 'platform:role.grant')) {
      throw new ForbiddenException('Only platform admins may manage operator invites')
    }
  }

  private requireBusinessName(input: string | undefined): string {
    const trimmed = input?.trim()
    if (!trimmed) throw new InviteBusinessNameRequiredError()
    return trimmed
  }

  private mintToken(): { rawToken: string; tokenHash: string; expiresAt: Date } {
    return this.tokens.mint(INVITE_TTL_MS)
  }

  // Raw token leaves the system only through the email channel — never in a response.
  private acceptUrl(rawToken: string): string {
    return this.tokens.acceptUrl('/invite/accept', rawToken)
  }

  private hashToken(token: string): string {
    return this.tokens.hash(token)
  }

  // `payload` must never carry the raw token or the accept password — only ids. Callers
  // pass ids/hashes-of-nothing-sensitive, never the invite's own email (PII).
  private async recordAudit(
    tx: Prisma.TransactionClient,
    actor: { id: string; role: string },
    action: string,
    entityId: string,
    payload?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        entityType: 'OperatorInvite',
        entityId,
        payload,
        ipAddress: RequestContext.getIp(),
      },
    })
  }

  private toSummary(invite: {
    id: string
    email: string
    businessName: string
    status: InviteStatus
    kind: OperatorInviteKind
    role: OperatorMemberRole
    operatorId: string | null
    expiresAt: Date
    createdAt: Date
    acceptedAt: Date | null
  }): InviteSummary {
    return {
      id: invite.id,
      email: invite.email,
      businessName: invite.businessName,
      status: invite.status,
      kind: invite.kind,
      role: invite.role,
      operatorId: invite.operatorId,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      acceptedAt: invite.acceptedAt,
    }
  }
}
