import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { IAuthProvider } from '@spark/auth'
import {
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
import { FIREBASE_AUTH_PROVIDER_TOKEN } from '../auth/auth.constants'
import { RequestContext } from '../common/context/request-context'
import { OperatorSuspendedError } from '../common/errors/domain.errors'
import { NotificationsService } from '../notifications/notifications.service'
import { OperatorAccessService } from '../operators/operator-access.service'
import { OperatorNotFoundError } from '../operators/operators.types'
import { PrismaService } from '../prisma/prisma.service'
import { EntitlementService } from '../subscriptions/entitlement.service'
import { InviteTokenService } from './invite-token.service'
import type { CreateInviteDto, CreateMemberInviteDto } from './dto/invite.dto'
import {
  InviteAlreadyAcceptedError,
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
    private readonly tokens: InviteTokenService,
    @Inject(FIREBASE_AUTH_PROVIDER_TOKEN) private readonly firebase: IAuthProvider,
  ) {}

  async create(actor: AuthUser, dto: CreateInviteDto): Promise<InviteIssued> {
    // Controller already gates on @RequirePermission('platform:role.grant'); re-check in
    // the service layer per the both-layers authorization rule.
    if (!hasPlatformPermission(actor.role, 'platform:role.grant')) {
      throw new ForbiddenException('Only platform admins may issue operator invites')
    }

    const { rawToken, tokenHash, expiresAt } = this.mintToken()
    const email = dto.email.toLowerCase()

    const invite = await this.prisma.$transaction(async (tx) => {
      const operator = await tx.parkingOperator.create({
        data: { name: dto.businessName, status: OperatorStatus.PENDING },
      })
      const created = await tx.operatorInvite.create({
        data: {
          email,
          businessName: dto.businessName,
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
      businessName: dto.businessName,
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

    const { rawToken, tokenHash, expiresAt } = this.mintToken()
    const email = dto.email.toLowerCase()

    const invite = await this.prisma.$transaction(async (tx) => {
      // Seats are checked at ISSUANCE, not at accept: a link that cannot be redeemed is
      // worse than a refusal the inviting admin sees immediately, and counting unredeemed
      // invites against the quota is what stops an operator on two seats from mailing out
      // twenty. Under the same operator-row lock the other quota paths take.
      await tx.$executeRaw`SELECT id FROM "ParkingOperator" WHERE id = ${operatorId} FOR UPDATE`
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

    await this.prisma.$transaction(async (tx) => {
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
            businessName: invite.businessName,
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
      select: { businessName: true, email: true, status: true, expiresAt: true, role: true },
    })
    if (!invite) throw new InviteNotFoundError()

    return {
      businessName: invite.businessName,
      email: invite.email,
      role: invite.role,
      expired: invite.status !== InviteStatus.PENDING || invite.expiresAt < new Date(),
    }
  }

  async accept(token: string, password: string): Promise<AuthResult> {
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

    // The privileges come off the invite, decided and authorized when it was issued. The
    // person redeeming the link never gets a say in them.
    const grantedRole = userRoleFor(invite.role)

    // Creates the Firebase identity AND the local User row; session.user.id is the
    // local Postgres id.
    const authResult = await this.firebase.signUp({
      email: invite.email,
      password,
      // The business name is the new operator's own name on the onboarding flow; on a
      // member invite it belongs to the employer, not the employee.
      displayName: isOnboarding ? invite.businessName : undefined,
      role: grantedRole,
    })
    const newUserId = authResult.session.user.id

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.operatorMembership.create({
          data: {
            operatorId,
            userId: newUserId,
            role: invite.role,
          },
        })
        if (isOnboarding) {
          await tx.parkingOperator.update({
            where: { id: operatorId },
            data: { status: OperatorStatus.VERIFIED, verifiedAt: new Date() },
          })
        }
        await tx.user.update({ where: { id: newUserId }, data: { emailVerified: true } })

        // Conditional on the very token that was redeemed: a revoke or a resend that
        // landed while the identity was being provisioned must beat this accept, and the
        // failed count rolls the whole attachment back (and the identity with it).
        const { count } = await tx.operatorInvite.updateMany({
          where: { id: invite.id, tokenHash: invite.tokenHash, status: InviteStatus.PENDING },
          data: { status: InviteStatus.ACCEPTED, acceptedAt: new Date() },
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
      // Firebase and Postgres cannot share one atomic transaction, so a failure after
      // the identity is created must be compensated by deleting that identity — otherwise
      // an orphaned Firebase+local user with no operator attachment is left behind.
      try {
        await this.firebase.deleteUser(newUserId)
      } catch (cleanupError) {
        this.logger.error(
          `Failed to roll back orphaned identity ${newUserId} after invite-accept failure: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        )
      }
      throw error
    }

    return authResult
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
