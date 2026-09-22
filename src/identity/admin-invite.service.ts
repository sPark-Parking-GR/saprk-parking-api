import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common'
import { InviteStatus, type PlatformAdminInvite, type Prisma } from '@prisma/client'
import type { AuthContext } from '@spark/auth'
import { hasPlatformPermission, type AuthResult, type AuthUser } from '@spark/types'
import { AccountLinkingService } from '../auth/account-linking.service'
import { AUTH_CONTEXT_TOKEN } from '../auth/auth.constants'
import { TO_PRISMA } from '../auth/authjs-user.store'
import { RequestContext } from '../common/context/request-context'
import { InviteTokenService } from '../invite/invite-token.service'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import type { CreateAdminInviteDto } from './dto/admin-invite.dto'
import {
  AdminInviteAlreadyAcceptedError,
  AdminInviteEmailTakenError,
  AdminInviteExpiredError,
  AdminInviteNotFoundError,
  AdminInviteNotResendableError,
  AdminInviteNotRevocableError,
  type AdminInviteIssued,
  type AdminInviteSummary,
  type AdminInviteValidation,
} from './admin-invite.types'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const ACCEPT_PATH = '/invite/admin/accept'

const RESENDABLE_STATUSES: InviteStatus[] = [InviteStatus.PENDING, InviteStatus.EXPIRED]

/**
 * How a platform administrator recruits a peer, and the ONLY identity capability a platform
 * admin holds.
 *
 * The asymmetry is the point: issuing this invite grants no visibility into any account,
 * including the one it creates. A platform admin can bring a colleague in and then cannot
 * list, read, suspend, re-role or delete them — that stays with super admins.
 *
 * Grants PLATFORM_ADMIN and only ever that. SUPER_ADMIN is unreachable from here by
 * construction: SignUpData.role does not admit it, so there is no value to pass.
 */
@Injectable()
export class AdminInviteService {
  private readonly logger = new Logger(AdminInviteService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly tokens: InviteTokenService,
    // The CONFIGURED provider, not a directly-constructed Firebase one. Provisioning used
    // to bypass AUTH_PROVIDER entirely, so every invited account was Firebase-backed
    // whatever the deployment had selected — which is both the strategy-pattern violation
    // CLAUDE.md forbids and the reason no e2e suite could ever redeem an invite.
    @Inject(AUTH_CONTEXT_TOKEN) private readonly auth: AuthContext,
    private readonly accountLinking: AccountLinkingService,
  ) {}

  async create(actor: AuthUser, dto: CreateAdminInviteDto): Promise<AdminInviteIssued> {
    this.assertMayInvite(actor)

    const email = dto.email.toLowerCase()
    // Issuance never needs ownership proof — only redemption (accept()) does. An address
    // that already has a mobile-only account may still be invited; that account is who
    // will end up redeeming it, by proving they own it with its own password.
    if ((await this.accountLinking.resolve(email)).kind === 'taken') {
      throw new AdminInviteEmailTakenError(email)
    }

    const { rawToken, tokenHash, expiresAt } = this.tokens.mint(INVITE_TTL_MS)

    const invite = await this.prisma.$transaction(async (tx) => {
      await this.supersede(tx, actor, email)
      const created = await tx.platformAdminInvite.create({
        data: {
          email,
          displayName: dto.displayName ?? null,
          tokenHash,
          invitedById: actor.id,
          expiresAt,
        },
      })
      await this.recordAudit(tx, actor, 'admin_invite.created', created.id)
      return created
    })

    const delivered = await this.notifications.sendPlatformAdminInvite({
      to: email,
      acceptUrl: this.tokens.acceptUrl(ACCEPT_PATH, rawToken),
      invitedByName: actor.displayName ?? actor.email,
    })

    return { ...toSummary(invite), delivered }
  }

  /**
   * Scoped to the caller unless they can read accounts anyway. A platform admin holds no
   * identity:user.read, so showing them every invite the platform ever issued would leak a
   * roster of administrator email addresses through the back door — the exact thing the
   * tier split withholds.
   */
  async list(actor: AuthUser): Promise<AdminInviteSummary[]> {
    this.assertMayInvite(actor)

    const invites = await this.prisma.platformAdminInvite.findMany({
      where: hasPlatformPermission(actor.role, 'identity:user.read')
        ? {}
        : { invitedById: actor.id },
      orderBy: { createdAt: 'desc' },
    })
    return invites.map(toSummary)
  }

  /**
   * Rotates the token and re-sends. Overwriting tokenHash IS the invalidation: the previous
   * hash no longer exists in the table, so the old link resolves to nothing.
   */
  async resend(actor: AuthUser, id: string): Promise<AdminInviteIssued> {
    this.assertMayInvite(actor)

    const invite = await this.findOwn(actor, id)
    if (invite.status === InviteStatus.ACCEPTED) throw new AdminInviteAlreadyAcceptedError()
    if (!RESENDABLE_STATUSES.includes(invite.status)) {
      throw new AdminInviteNotResendableError(invite.status)
    }

    // Expiry is reset rather than inherited: a resend exists because the first link never
    // usably arrived, and a replacement that is already dead recreates the failure.
    const { rawToken, tokenHash, expiresAt } = this.tokens.mint(INVITE_TTL_MS)

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.platformAdminInvite.update({
        where: { id },
        data: { tokenHash, expiresAt, status: InviteStatus.PENDING },
      })
      await this.recordAudit(tx, actor, 'admin_invite.resent', id)
      return row
    })

    const delivered = await this.notifications.sendPlatformAdminInvite({
      to: updated.email,
      acceptUrl: this.tokens.acceptUrl(ACCEPT_PATH, rawToken),
      invitedByName: actor.displayName ?? actor.email,
    })

    return { ...toSummary(updated), delivered }
  }

  async revoke(actor: AuthUser, id: string): Promise<AdminInviteSummary> {
    this.assertMayInvite(actor)

    const invite = await this.findOwn(actor, id)
    if (invite.status === InviteStatus.ACCEPTED) throw new AdminInviteAlreadyAcceptedError()
    if (invite.status !== InviteStatus.PENDING) {
      throw new AdminInviteNotRevocableError(invite.status)
    }

    return this.prisma.$transaction(async (tx) => {
      // Conditional on PENDING so a racing accept either wins or loses cleanly, never both.
      const { count } = await tx.platformAdminInvite.updateMany({
        where: { id, status: InviteStatus.PENDING },
        data: { status: InviteStatus.REVOKED },
      })
      if (count === 0) throw new AdminInviteAlreadyAcceptedError()

      await this.recordAudit(tx, actor, 'admin_invite.revoked', id)
      return toSummary({ ...invite, status: InviteStatus.REVOKED })
    })
  }

  /** Public: the recipient has no account yet, so this is what the accept page renders from. */
  async validate(token: string): Promise<AdminInviteValidation> {
    const invite = await this.prisma.platformAdminInvite.findUnique({
      where: { tokenHash: this.tokens.hash(token) },
    })
    if (!invite) throw new AdminInviteNotFoundError()

    const resolution = await this.accountLinking.resolve(invite.email)

    return {
      email: invite.email,
      expired: invite.status !== InviteStatus.PENDING || invite.expiresAt < new Date(),
      requiresExistingPassword: resolution.kind === 'linkable',
    }
  }

  /**
   * Public. The privileges come off the invite, decided and authorized when it was issued —
   * the person redeeming the link never gets a say in them.
   */
  async accept(token: string, password: string): Promise<AuthResult | { linked: true }> {
    const invite = await this.prisma.platformAdminInvite.findUnique({
      where: { tokenHash: this.tokens.hash(token) },
    })
    if (!invite) throw new AdminInviteNotFoundError()
    if (invite.status === InviteStatus.ACCEPTED) throw new AdminInviteAlreadyAcceptedError()

    if (invite.status !== InviteStatus.PENDING || invite.expiresAt < new Date()) {
      // Self-heal a lapsed-but-still-PENDING invite so its state reflects reality.
      if (invite.status === InviteStatus.PENDING) {
        await this.prisma.platformAdminInvite.update({
          where: { id: invite.id },
          data: { status: InviteStatus.EXPIRED },
        })
      }
      throw new AdminInviteExpiredError()
    }

    // Re-checked at redemption, not only at issuance: the address may have changed state
    // during the seven days the link was live. `free` proceeds to signUp as before;
    // `linkable` attaches to the existing mobile-only account instead of colliding with
    // it — the person redeeming it proves it is theirs by signing in with its password,
    // which is the deliberate act promoting an existing account requires, not a side
    // effect of the link existing; `taken` is genuinely gone.
    const resolution = await this.accountLinking.resolve(invite.email)
    if (resolution.kind === 'taken') throw new AdminInviteEmailTakenError(invite.email)
    const isLinking = resolution.kind === 'linkable'

    let newUserId: string
    let authResult: AuthResult | undefined
    if (isLinking) {
      // Proves the redeemer actually owns this account before any privilege is granted on
      // its behalf. A wrong password collapses into the SAME error as a genuinely-taken
      // address, deliberately — this is the platform's most-privileged tier, and letting a
      // failed guess read differently from "taken" would turn accept() into an oracle
      // telling an attacker holding the invite token which emails are low-privilege driver
      // accounts ripe for escalation to platform_admin.
      try {
        await this.accountLinking.verifyOwnership(invite.email, password)
      } catch {
        throw new AdminInviteEmailTakenError(invite.email)
      }
      newUserId = resolution.userId
    } else {
      // Creates the Firebase identity AND the local User row; session.user.id is the local id.
      authResult = await this.auth.signUp({
        email: invite.email,
        password,
        displayName: invite.displayName ?? undefined,
        role: 'platform_admin',
      })
      newUserId = authResult.session.user.id
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        if (isLinking) {
          // Locked first, before any write: nothing else serializes two concurrent
          // redemptions landing on the same linkable address the way the `User.email`
          // unique index serializes two `signUp`s.
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
            throw new AdminInviteEmailTakenError(invite.email)
          }
        }

        await tx.user.update({
          where: { id: newUserId },
          data: {
            emailVerified: true,
            // A role grant is a privilege change like any other in this codebase and must
            // bump the revocation watermark: without it, a still-live mobile session token
            // for this account becomes a valid platform_admin token the instant this commits.
            ...(isLinking ? { role: TO_PRISMA.platform_admin, sessionsValidFrom: new Date() } : {}),
          },
        })

        // Conditional on the very token redeemed: a revoke or resend that landed while the
        // identity was being provisioned must beat this accept, and a failed count rolls
        // the whole thing back — the new identity included.
        const { count } = await tx.platformAdminInvite.updateMany({
          where: { id: invite.id, tokenHash: invite.tokenHash, status: InviteStatus.PENDING },
          data: { status: InviteStatus.ACCEPTED, acceptedAt: new Date() },
        })
        if (count === 0) throw new AdminInviteExpiredError()

        await this.recordAudit(
          tx,
          { id: newUserId, role: 'platform_admin' },
          'admin_invite.accepted',
          invite.id,
          isLinking,
        )
      })
    } catch (error) {
      // Firebase and Postgres cannot share one atomic transaction, so a failure after a
      // FRESH identity exists must be compensated by deleting it — otherwise a
      // redeemable-looking orphan platform admin is left behind. A linked account predates
      // this request and is not this request's to destroy, even on failure.
      if (!isLinking) {
        try {
          await this.auth.deleteUser(newUserId)
        } catch (cleanupError) {
          this.logger.error(
            `Failed to roll back orphaned identity ${newUserId} after admin-invite-accept failure: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          )
        }
      }
      throw error
    }

    // Not re-minted here on purpose: the transaction above just bumped
    // sessionsValidFrom, and a token issued in that same instant risks landing in the same
    // whole second as the watermark — dead on arrival under the fail-closed tie-break in
    // packages/auth/src/revocation.ts. The caller already knows this password; they sign
    // in themselves, afterward.
    if (isLinking) return { linked: true }

    return authResult!
  }

  private async findOwn(actor: AuthUser, id: string): Promise<PlatformAdminInvite> {
    const invite = await this.prisma.platformAdminInvite.findUnique({ where: { id } })
    if (!invite) throw new AdminInviteNotFoundError()

    // 404 rather than 403 for someone else's invite, so the endpoint does not confirm that
    // an id exists to a caller who may not see it.
    if (
      invite.invitedById !== actor.id &&
      !hasPlatformPermission(actor.role, 'identity:user.read')
    ) {
      throw new AdminInviteNotFoundError()
    }
    return invite
  }

  private assertMayInvite(actor: AuthUser): void {
    // Controller already gates on @RequirePermission('identity:admin.invite'); re-check in
    // the service layer per the both-layers authorization rule.
    if (!hasPlatformPermission(actor.role, 'identity:admin.invite')) {
      throw new ForbiddenException('Only platform administrators may invite a peer')
    }
  }

  /**
   * Retires every live invite to this address, so it never holds more than one redeemable
   * platform_admin grant at a time.
   *
   * Without this, issuing a second invite to an address left the first one working: an
   * admin who revokes the invite they can see in the UI (their own — `list()` scopes a
   * platform admin to invites they issued) has not actually withdrawn platform_admin from
   * that address if a DIFFERENT admin also invited it. Mirrors
   * `invite.service.ts#supersede()`, minus the shell-operator cleanup that flow needs and
   * this one has no equivalent of.
   */
  private async supersede(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    email: string,
  ): Promise<void> {
    const stale = await tx.platformAdminInvite.findMany({
      where: { email, status: InviteStatus.PENDING },
      select: { id: true },
    })
    if (stale.length === 0) return

    const ids = stale.map((invite) => invite.id)
    await tx.platformAdminInvite.updateMany({
      where: { id: { in: ids }, status: InviteStatus.PENDING },
      data: { status: InviteStatus.REVOKED },
    })

    for (const id of ids) {
      await this.recordAudit(tx, actor, 'admin_invite.superseded', id)
    }
  }

  // `linked` distinguishes a role grant on a pre-existing mobile account from a brand-new
  // identity — not otherwise reconstructable from the audit trail without cross-
  // referencing the account's own createdAt. Never the raw token, the password, or the
  // invitee's email.
  private async recordAudit(
    tx: Prisma.TransactionClient,
    actor: { id: string; role: string },
    action: string,
    inviteId: string,
    linked?: boolean,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        entityType: 'PlatformAdminInvite',
        entityId: inviteId,
        ...(linked !== undefined ? { payload: { linked } } : {}),
        ipAddress: RequestContext.getIp(),
      },
    })
  }
}

function toSummary(invite: PlatformAdminInvite): AdminInviteSummary {
  return {
    id: invite.id,
    email: invite.email,
    displayName: invite.displayName,
    status: invite.status,
    invitedById: invite.invitedById,
    expiresAt: invite.expiresAt.toISOString(),
    acceptedAt: invite.acceptedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
  }
}
