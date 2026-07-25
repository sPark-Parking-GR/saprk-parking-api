import { createHash, randomBytes } from 'crypto'
import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { IAuthProvider } from '@spark/auth'
import type { AuthResult, AuthUser } from '@spark/types'
import { InviteStatus, OperatorMemberRole, OperatorStatus } from '@prisma/client'
import { FIREBASE_AUTH_PROVIDER_TOKEN } from '../auth/auth.constants'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import type { CreateInviteDto } from './dto/invite.dto'
import {
  InviteAlreadyAcceptedError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteNotRevocableError,
  type InviteSummary,
  type InviteValidation,
} from './invite.types'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    @Inject(FIREBASE_AUTH_PROVIDER_TOKEN) private readonly firebase: IAuthProvider,
  ) {}

  async create(actor: AuthUser, dto: CreateInviteDto): Promise<InviteSummary> {
    // Controller already gates on @Roles('platform_admin'); re-check in the service
    // layer per the both-layers authorization rule.
    if (actor.role !== 'platform_admin') {
      throw new ForbiddenException('Only platform admins may issue operator invites')
    }

    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = this.hashToken(rawToken)
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
    const email = dto.email.toLowerCase()

    const invite = await this.prisma.$transaction(async (tx) => {
      const operator = await tx.parkingOperator.create({
        data: { name: dto.businessName, status: OperatorStatus.PENDING },
      })
      return tx.operatorInvite.create({
        data: {
          email,
          businessName: dto.businessName,
          operatorId: operator.id,
          tokenHash,
          invitedById: actor.id,
          expiresAt,
        },
      })
    })

    // Raw token leaves the system only through the email channel — never in a response.
    const acceptUrl = `${this.config.getOrThrow<string>('WEB_APP_URL')}/invite/accept/${rawToken}`
    await this.notifications.sendOperatorInvite({
      to: email,
      businessName: dto.businessName,
      acceptUrl,
    })

    return this.toSummary(invite)
  }

  async list(actor: AuthUser): Promise<InviteSummary[]> {
    // Controller already gates on @Roles('platform_admin'); re-check in the service
    // layer per the both-layers authorization rule.
    if (actor.role !== 'platform_admin') {
      throw new ForbiddenException('Only platform admins may view operator invites')
    }

    const invites = await this.prisma.operatorInvite.findMany({
      orderBy: { createdAt: 'desc' },
    })
    return invites.map((invite) => this.toSummary(invite))
  }

  async revoke(actor: AuthUser, id: string): Promise<void> {
    // Controller already gates on @Roles('platform_admin'); re-check in the service
    // layer per the both-layers authorization rule.
    if (actor.role !== 'platform_admin') {
      throw new ForbiddenException('Only platform admins may revoke operator invites')
    }

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
      select: { businessName: true, email: true, status: true, expiresAt: true },
    })
    if (!invite) throw new InviteNotFoundError()

    return {
      businessName: invite.businessName,
      email: invite.email,
      expired: invite.status !== InviteStatus.PENDING || invite.expiresAt < new Date(),
    }
  }

  async accept(token: string, password: string): Promise<AuthResult> {
    const invite = await this.prisma.operatorInvite.findUnique({
      where: { tokenHash: this.hashToken(token) },
    })
    if (!invite) throw new InviteNotFoundError()
    if (invite.status === InviteStatus.ACCEPTED) throw new InviteAlreadyAcceptedError()

    if (invite.status !== InviteStatus.PENDING || invite.expiresAt < new Date() || !invite.operatorId) {
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

    // Creates the Firebase identity AND the local User row; session.user.id is the
    // local Postgres id.
    const authResult = await this.firebase.signUp({
      email: invite.email,
      password,
      displayName: invite.businessName,
      role: 'operator_admin',
    })
    const newUserId = authResult.session.user.id

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.operatorMembership.create({
          data: {
            operatorId,
            userId: newUserId,
            role: OperatorMemberRole.ADMIN,
          },
        })
        await tx.parkingOperator.update({
          where: { id: operatorId },
          data: { status: OperatorStatus.VERIFIED, verifiedAt: new Date() },
        })
        await tx.user.update({ where: { id: newUserId }, data: { emailVerified: true } })
        await tx.operatorInvite.update({
          where: { id: invite.id },
          data: { status: InviteStatus.ACCEPTED, acceptedAt: new Date() },
        })
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

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  private toSummary(invite: {
    id: string
    email: string
    businessName: string
    status: InviteStatus
    expiresAt: Date
    createdAt: Date
    acceptedAt: Date | null
  }): InviteSummary {
    return {
      id: invite.id,
      email: invite.email,
      businessName: invite.businessName,
      status: invite.status,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      acceptedAt: invite.acceptedAt,
    }
  }
}
