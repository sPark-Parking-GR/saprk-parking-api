import { Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { OperatorMemberRole, OperatorStatus } from '@prisma/client'
import type { AuthContext } from '@spark/auth'
import type { AuthResult } from '@spark/types'
import { AccountLinkingService } from '../auth/account-linking.service'
import { AUTH_CONTEXT_TOKEN } from '../auth/auth.constants'
import { TO_PRISMA } from '../auth/authjs-user.store'
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
    private readonly accountLinking: AccountLinkingService,
  ) {}

  isEnabled(): boolean {
    return this.config.get<string>('OPERATOR_SELF_SIGNUP_ENABLED') === 'true'
  }

  async register(dto: RegisterOperatorDto): Promise<AuthResult | { linked: true }> {
    if (!this.isEnabled()) throw new SelfSignupDisabledError()

    const email = dto.email.toLowerCase()
    // `free` proceeds to signUp as before; `linkable` means the address already has a
    // mobile-only account, which becomes this operator's admin instead of colliding with
    // it; `taken` means it genuinely belongs to someone/something else already.
    const resolution = await this.accountLinking.resolve(email)
    if (resolution.kind === 'taken') throw new OperatorEmailTakenError()
    const isLinking = resolution.kind === 'linkable'

    let newUserId: string
    let authResult: AuthResult | undefined
    if (isLinking) {
      // Proves the registrant actually owns this account before any privilege is granted
      // on its behalf. A wrong password collapses into the SAME error as a genuinely-taken
      // address, deliberately — this is a public, unauthenticated endpoint, and letting a
      // failed guess (401) read differently from "taken" (409) would turn it into an oracle
      // that tells a credential-stuffing attacker which emails are low-privilege driver
      // accounts ripe for escalation, distinct from ones already spoken for. A correct
      // guess is the only thing anyone is allowed to learn anything from.
      try {
        await this.accountLinking.verifyOwnership(email, dto.password)
      } catch {
        throw new OperatorEmailTakenError()
      }
      newUserId = resolution.userId
    } else {
      // Creates the Firebase identity AND the local User row, exactly as invite acceptance
      // does. operator_admin from the outset: they own the business they just registered —
      // what is withheld is the operator's VERIFIED status, not their role.
      authResult = await this.auth.signUp({
        email,
        password: dto.password,
        // No fallback to the business name: displayName is the PERSON, and defaulting it to
        // the company put a business in every list that names a human, permanently — there is
        // no edit path today beyond the profile page. Absent is honest; the UI renders the
        // email instead.
        ...(dto.displayName ? { displayName: dto.displayName } : {}),
        role: 'operator_admin',
      })
      newUserId = authResult.session.user.id
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        if (isLinking) {
          // Locked first, before any operator/membership write: nothing else serializes
          // two concurrent self-registrations landing on the same linkable address the way
          // the `User.email` unique index serializes two `signUp`s.
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
            throw new OperatorEmailTakenError()
          }
        }

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

        if (isLinking) {
          // A role grant is a privilege change like any other in this codebase and must
          // bump the revocation watermark: without it, a still-live mobile session token
          // for this account becomes a valid operator_admin token the instant this commits.
          await tx.user.update({
            where: { id: newUserId },
            data: { role: TO_PRISMA.operator_admin, sessionsValidFrom: new Date() },
          })
        }

        await tx.auditLog.create({
          data: {
            actorId: newUserId,
            actorRole: 'operator_admin',
            action: 'operator.self_registered',
            entityType: 'ParkingOperator',
            entityId: operator.id,
            // `linked` distinguishes a role grant on a pre-existing mobile account from a
            // brand-new identity — not otherwise reconstructable from the audit trail alone.
            payload: { businessName: dto.businessName, linked: isLinking },
            ipAddress: RequestContext.getIp(),
          },
        })
      })
    } catch (error) {
      // Firebase and Postgres cannot share a transaction, so a FRESH identity created
      // before a failed attachment has to be compensated — otherwise the address is taken
      // by an account that owns nothing and the person cannot retry. A linked account
      // predates this request and is not this request's to destroy, even on failure.
      if (!isLinking) {
        try {
          await this.auth.deleteUser(newUserId)
        } catch (cleanupError) {
          this.logger.error(
            `Failed to roll back orphaned identity ${newUserId} after operator registration failure: ${
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
}
