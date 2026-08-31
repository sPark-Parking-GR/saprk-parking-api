import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common'
import { BookingStatus, type Prisma } from '@prisma/client'
import { InvalidTokenError } from '@spark/auth'
import type { AuthContext, IAuthProvider } from '@spark/auth'
import type { AuthUser } from '@spark/types'
import { PrismaService } from '../prisma/prisma.service'
import { AUTH_CONTEXT_TOKEN, FIREBASE_AUTH_PROVIDER_TOKEN } from './auth.constants'
import { AccountHasUnsettledBookingsError } from './auth.types'

// Reserved by RFC 2606, so the rewritten address can never be delivered to, and unique per
// row because User.email is unique and a tombstone must not collide with the next one.
const tombstoneEmail = (userId: string): string => `deleted+${userId}@deleted.invalid`

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTH_CONTEXT_TOKEN) private readonly auth: AuthContext,
    // Typed as the port, not the Firebase class: under a provider with no remote
    // identity these calls are honest no-ops rather than a construction error.
    @Inject(FIREBASE_AUTH_PROVIDER_TOKEN) private readonly firebase: IAuthProvider | null,
  ) {}

  /**
   * Erases the caller's own account, in the only way the data model allows: the User row
   * survives stripped of everything that identifies a person, because Booking.userId is
   * NOT NULL behind an ON DELETE RESTRICT foreign key and those rows carry payments,
   * refunds and an operator's own accounting. A hard delete would either be refused by the
   * database the moment somebody had parked once, or — with a cascade — take the financial
   * record with it. What is left afterwards is a booking history attached to nobody.
   *
   * Vehicles go, since a plate identifies its owner and the saved garage is pure
   * convenience data; `Booking.vehicleId` is ON DELETE SET NULL and `Booking.vehiclePlate`
   * is denormalised, so the operator's record of which car was in the bay is untouched.
   * Wallet and reviews stay: one is a credit ledger and the other is facility rating data,
   * and neither identifies anybody once the user row is anonymous.
   *
   * Sessions die two ways at once — the sessionsValidFrom watermark rejects every token
   * already issued, and `deletedAt` makes the revocation check refuse this account
   * unconditionally from here on.
   */
  async deleteOwnAccount(user: AuthUser, password: string, accessToken: string): Promise<void> {
    // Repeated from the controller's @Roles gate on purpose: an operator or admin identity
    // owns memberships, invites and facilities that a self-service tombstone would strand,
    // and their removal is the invite flow's business, not this endpoint's.
    if (user.role !== 'user') {
      throw new ForbiddenException('Only consumer accounts can be deleted from the app')
    }

    const account = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, email: true, firebaseUid: true, deletedAt: true },
    })
    // Unreachable through the guard, which rejects both cases before the handler runs.
    if (!account || account.deletedAt) throw new InvalidTokenError()

    // Proof of person, not just of session. Routed through the auth context so it works
    // against whichever backend holds the credential, and left to throw
    // InvalidCredentialsError → 401 rather than reporting a wrong password as anything
    // more specific.
    await this.auth.signIn({ email: account.email, password })

    const unsettled = await this.prisma.booking.count({ where: this.unsettledWhere(user.id) })
    if (unsettled > 0) throw new AccountHasUnsettledBookingsError(unsettled)

    const deletedAt = new Date()
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          email: tombstoneEmail(user.id),
          displayName: null,
          avatarUrl: null,
          passwordHash: null,
          firebaseUid: null,
          emailVerified: false,
          deletedAt,
          sessionsValidFrom: deletedAt,
        },
      })
      await tx.vehicle.deleteMany({ where: { userId: user.id } })
      // The reset grants outlive the credential they would set otherwise, and each one is
      // a live path to writing a password onto a tombstone.
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id } })
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'account.deleted',
          entityType: 'User',
          entityId: user.id,
          payload: { selfService: true },
        },
      })
    })

    // Revokes Google's own refresh tokens for a Firebase-backed account; for an authjs one
    // it re-does the watermark the transaction already moved. Never fatal — the session it
    // closes cannot outlive the tombstone either way.
    await this.auth.signOut(accessToken).catch(() => undefined)

    // Best effort, and deliberately after the local write: the account is already gone as
    // far as this platform is concerned, so failing the request now would report a
    // deletion that did happen as one that did not. A stranded Google identity is an ops
    // cleanup item, which is why the uid is logged — it is no longer stored anywhere.
    if (account.firebaseUid) {
      try {
        // Null when the deployment configures no Firebase credentials. A row that still
        // carries a uid then has a credential nobody here can release — worth an explicit
        // message, because the alternative is a null dereference inside this catch and a
        // log line that blames the wrong thing.
        if (!this.firebase) {
          throw new Error('no identity provider is configured to release it')
        }
        await this.firebase.deleteIdentity(account.firebaseUid)
      } catch (error) {
        this.logger.error(
          `Account ${user.id} was deleted but its Firebase identity ${account.firebaseUid} was not removed`,
          error instanceof Error ? error.stack : String(error),
        )
      }
    }
  }

  // A booking nobody can settle once the account is anonymous: money mid-flight, a bay the
  // operator is still holding, or a car currently inside one.
  private unsettledWhere(userId: string): Prisma.BookingWhereInput {
    const now = new Date()
    return {
      userId,
      OR: [
        {
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] },
          endsAt: { gt: now },
        },
        { status: BookingStatus.PENDING_PAYMENT, expiresAt: { gt: now } },
        { status: BookingStatus.REFUND_PENDING },
      ],
    }
  }
}
