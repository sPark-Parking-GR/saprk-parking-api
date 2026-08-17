import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common'
import { InviteStatus, type PlatformAdminInvite, type Prisma } from '@prisma/client'
import type { IAuthProvider } from '@spark/auth'
import { hasPlatformPermission, type AuthResult, type AuthUser } from '@spark/types'
import { FIREBASE_AUTH_PROVIDER_TOKEN } from '../auth/auth.constants'
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
    @Inject(FIREBASE_AUTH_PROVIDER_TOKEN) private readonly firebase: IAuthProvider,
  ) {}

  async create(actor: AuthUser, dto: CreateAdminInviteDto): Promise<AdminInviteIssued> {
    this.assertMayInvite(actor)

    const email = dto.email.toLowerCase()
    await this.assertEmailFree(email)

    const { rawToken, tokenHash, expiresAt } = this.tokens.mint(INVITE_TTL_MS)

    const invite = await this.prisma.$transaction(async (tx) => {
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

    return {
      email: invite.email,
      expired: invite.status !== InviteStatus.PENDING || invite.expiresAt < new Date(),
    }
  }

  /**
   * Public. The privileges come off the invite, decided and authorized when it was issued —
   * the person redeeming the link never gets a say in them.
   */
  async accept(token: string, password: string): Promise<AuthResult> {
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

    // Re-checked at redemption, not only at issuance: the address may have signed up during
    // the seven days the link was live, and silently promoting that account is exactly the
    // escalation this refuses.
    await this.assertEmailFree(invite.email)

    // Creates the Firebase identity AND the local User row; session.user.id is the local id.
    const authResult = await this.firebase.signUp({
      email: invite.email,
      password,
      displayName: invite.displayName ?? undefined,
      role: 'platform_admin',
    })
    const newUserId = authResult.session.user.id

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: newUserId }, data: { emailVerified: true } })

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
        )
      })
    } catch (error) {
      // Firebase and Postgres cannot share one atomic transaction, so a failure after the
      // identity exists must be compensated by deleting it — otherwise a redeemable-looking
      // orphan platform admin is left behind, which is worse than a failed invite.
      try {
        await this.firebase.deleteUser(newUserId)
      } catch (cleanupError) {
        this.logger.error(
          `Failed to roll back orphaned identity ${newUserId} after admin-invite-accept failure: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        )
      }
      throw error
    }

    return authResult
  }

  private async assertEmailFree(email: string): Promise<void> {
    // Names lifecycleStatus so the Prisma lifecycle extension does not narrow this to
    // ACTIVE: an archived or anonymised account still owns its address, and inviting over
    // one would collide on User.email at signUp with a far less clear failure.
    const existing = await this.prisma.user.findFirst({
      where: { email, lifecycleStatus: { in: ['ACTIVE', 'ARCHIVED', 'TOMBSTONED', 'PURGED'] } },
      select: { id: true },
    })
    if (existing) throw new AdminInviteEmailTakenError(email)
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

  // payload carries ids only — never the raw token, the password, or the invitee's email.
  private async recordAudit(
    tx: Prisma.TransactionClient,
    actor: { id: string; role: string },
    action: string,
    inviteId: string,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        entityType: 'PlatformAdminInvite',
        entityId: inviteId,
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
