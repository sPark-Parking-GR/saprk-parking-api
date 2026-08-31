import { Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { OperatorMemberRole, OperatorStatus } from '@prisma/client'
import type { AuthContext } from '@spark/auth'
import type { AuthResult } from '@spark/types'
import { AUTH_CONTEXT_TOKEN } from '../auth/auth.constants'
import { RequestContext } from '../common/context/request-context'
import { PrismaService } from '../prisma/prisma.service'
import type { RegisterOperatorDto } from './dto/operator-registration.dto'
import { OperatorEmailTakenError, SelfSignupDisabledError } from './operators.types'

/**
 * Public operator registration — the post-release replacement for invite-only onboarding.
 *
 * The business lands PENDING, which is a real quarantine rather than a cosmetic flag: a
 * pending operator cannot publish facilities, cannot invite members, and is not counted by
 * the last-admin guard. A platform admin verifies it from the operator directory, and only
 * then does it become a working tenant.
 *
 * Pre-release this is simply switched off, and the invite flow remains the only way in.
 * Going public is a config change, not a deploy — which also means it can be switched back
 * off in an incident without shipping anything.
 */
@Injectable()
export class OperatorRegistrationService {
  private readonly logger = new Logger(OperatorRegistrationService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    // The CONFIGURED provider, not a directly-constructed Firebase one. Provisioning used
    // to bypass AUTH_PROVIDER entirely, so every invited account was Firebase-backed
    // whatever the deployment had selected — which is both the strategy-pattern violation
    // CLAUDE.md forbids and the reason no e2e suite could ever redeem an invite.
    @Inject(AUTH_CONTEXT_TOKEN) private readonly auth: AuthContext,
  ) {}

  isEnabled(): boolean {
    return this.config.get<string>('OPERATOR_SELF_SIGNUP_ENABLED') === 'true'
  }

  async register(dto: RegisterOperatorDto): Promise<AuthResult> {
    if (!this.isEnabled()) throw new SelfSignupDisabledError()

    const email = dto.email.toLowerCase()
    await this.assertEmailFree(email)

    // Creates the Firebase identity AND the local User row, exactly as invite acceptance
    // does. operator_admin from the outset: they own the business they just registered —
    // what is withheld is the operator's VERIFIED status, not their role.
    const authResult = await this.auth.signUp({
      email,
      password: dto.password,
      // No fallback to the business name: displayName is the PERSON, and defaulting it to
      // the company put a business in every list that names a human, permanently — there is
      // no edit path today beyond the profile page. Absent is honest; the UI renders the
      // email instead.
      ...(dto.displayName ? { displayName: dto.displayName } : {}),
      role: 'operator_admin',
    })
    const newUserId = authResult.session.user.id

    try {
      await this.prisma.$transaction(async (tx) => {
        const operator = await tx.parkingOperator.create({
          data: { name: dto.businessName, status: OperatorStatus.PENDING },
        })
        await tx.operatorMembership.create({
          data: {
            operatorId: operator.id,
            userId: newUserId,
            role: OperatorMemberRole.ADMIN,
            // Admins derive their scopes; nothing to store.
            scopes: [],
          },
        })

        await tx.auditLog.create({
          data: {
            actorId: newUserId,
            actorRole: 'operator_admin',
            action: 'operator.self_registered',
            entityType: 'ParkingOperator',
            entityId: operator.id,
            payload: { businessName: dto.businessName },
            ipAddress: RequestContext.getIp(),
          },
        })
      })
    } catch (error) {
      // Firebase and Postgres cannot share a transaction, so an identity created before a
      // failed attachment has to be compensated — otherwise the address is taken by an
      // account that owns nothing and the person cannot retry.
      try {
        await this.auth.deleteUser(newUserId)
      } catch (cleanupError) {
        this.logger.error(
          `Failed to roll back orphaned identity ${newUserId} after operator registration failure: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        )
      }
      throw error
    }

    return authResult
  }

  private async assertEmailFree(email: string): Promise<void> {
    // Names lifecycleStatus so the Prisma extension does not narrow this to ACTIVE: an
    // archived or anonymised account still owns its address, and signUp would otherwise
    // fail on the unique constraint with a far less useful message.
    const existing = await this.prisma.user.findFirst({
      where: { email, lifecycleStatus: { in: ['ACTIVE', 'ARCHIVED', 'TOMBSTONED', 'PURGED'] } },
      select: { id: true },
    })
    if (existing) throw new OperatorEmailTakenError()
  }
}
