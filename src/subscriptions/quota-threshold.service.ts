import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { OperatorMemberRole, Prisma } from '@prisma/client'
import type { OperatorUsage } from '@spark/types'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import { EntitlementService } from './entitlement.service'

/**
 * The audit action that IS the dedup record. Written once per
 * (subscription, resource, threshold), which is why there is no table behind this feature:
 * the log already answers "have we told them?" and resets itself on an upgrade, because a
 * new plan means a new OperatorSubscription id and therefore an entity nothing was ever
 * recorded against.
 */
export const QUOTA_THRESHOLD_WARNED_ACTION = 'operator_subscription.quota_threshold_warned'

export type QuotaResource = keyof OperatorUsage

/** Percentages, not fractions: they are written into the audit payload and read by humans. */
export type QuotaThreshold = 80 | 100

interface QuotaDefinition {
  resource: QuotaResource
  limitKey: 'maxFacilities' | 'maxTariffPlans' | 'maxStaffSeats'
  label: string
}

const QUOTAS: readonly QuotaDefinition[] = [
  { resource: 'facilities', limitKey: 'maxFacilities', label: 'facilities' },
  { resource: 'tariffPlans', limitKey: 'maxTariffPlans', label: 'tariff plans' },
  { resource: 'staffSeats', limitKey: 'maxStaffSeats', label: 'staff seats' },
]

interface CrossedThreshold {
  resource: QuotaResource
  label: string
  threshold: QuotaThreshold
  current: number
  limit: number
}

interface AuditEntity {
  entityType: 'OperatorSubscription' | 'ParkingOperator'
  entityId: string
}

/**
 * Integer comparison rather than `current / limit >= 0.8`: the ratio is a float compared
 * against a decimal that has no exact binary form, and a limit of 0 makes it NaN — which
 * silently answers "no" to every threshold. A plan granting none of a resource has no
 * percentage of it to be at, so only actually holding some of one is worth saying anything
 * about.
 */
function thresholdsFor(
  quota: QuotaDefinition,
  limit: number | null,
  current: number,
): CrossedThreshold[] {
  if (limit === null) return []

  const at80 = limit === 0 ? current > 0 : current * 100 >= limit * 80
  const at100 = limit === 0 ? current > 0 : current >= limit

  const make = (threshold: QuotaThreshold): CrossedThreshold => ({
    resource: quota.resource,
    label: quota.label,
    threshold,
    current,
    limit,
  })

  // Ascending, so the caller can take the last element as the loudest one crossed.
  return [...(at80 ? [make(80)] : []), ...(at100 ? [make(100)] : [])]
}

/**
 * Tells an operator they are running out of what they bought, once per threshold per
 * subscription.
 *
 * Deliberately a service of its own rather than more methods on EntitlementService: that
 * class refuses writes and must stay callable inside a locked transaction, while this one
 * sends email and must never run inside one. Keeping them apart is what stops a future
 * caller from wiring a mail send into the middle of a `SELECT ... FOR UPDATE`.
 *
 * AFTER THE COMMIT, NOT INSIDE IT. Every call site invokes this once its transaction has
 * returned, mirroring how InviteService.createMember mails the invite only after the row is
 * durable. Two reasons: an SMTP round trip inside the operator-row lock would hold that lock
 * — the one thing serializing concurrent creates — for the length of a network call; and the
 * nudge is about state that has already happened, so a rollback must not be able to leave a
 * "you are at your limit" email behind for a facility that never existed.
 *
 * NOTHING HERE MAY FAIL THE CALLER. The public method swallows and logs, so the worst a
 * broken mail provider or a lost audit write can cost is the nudge, never the create the
 * customer actually asked for.
 */
@Injectable()
export class QuotaThresholdService {
  private readonly logger = new Logger(QuotaThresholdService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  async checkOperatorQuotaThresholds(operatorId: string): Promise<void> {
    try {
      await this.check(operatorId)
    } catch (error) {
      this.logger.error(
        { operatorId, error: error instanceof Error ? error.message : String(error) },
        'Quota threshold check failed',
      )
    }
  }

  private async check(operatorId: string): Promise<void> {
    if (this.entitlements.isQuotaExempt(operatorId)) return

    // Resolved fresh rather than passed in by the caller: the numbers must describe the
    // committed state, and the caller's were read under a lock that has since been released.
    const { entitlements, usage, subscriptionId } = await this.entitlements.describe(operatorId)

    const crossed = QUOTAS.flatMap((quota) =>
      thresholdsFor(quota, entitlements[quota.limitKey], usage[quota.resource]),
    )
    if (crossed.length === 0) return

    const operator = await this.prisma.parkingOperator.findUnique({
      where: { id: operatorId },
      select: { name: true },
    })
    if (!operator) return

    const recipients = await this.adminEmails(operatorId)
    // Nothing is recorded when there is nobody to tell, so the first administrator to exist
    // still gets the nudge instead of inheriting a dedup row for an email never sent.
    if (recipients.length === 0) {
      this.logger.warn(
        { operatorId },
        'Quota threshold crossed but the operator has no reachable administrator',
      )
      return
    }

    const entity = this.auditEntity(operatorId, subscriptionId)
    const billingUrl = `${this.config.getOrThrow<string>('WEB_APP_URL')}/dashboard/billing`

    for (const quota of QUOTAS) {
      const fresh: CrossedThreshold[] = []
      for (const candidate of crossed.filter((c) => c.resource === quota.resource)) {
        if (await this.alreadyWarned(entity, candidate)) continue
        fresh.push(candidate)
      }
      if (fresh.length === 0) continue

      // Only the loudest new threshold is mailed. Going from nothing to a full quota in one
      // create crosses both at once, and two emails a second apart reads as a broken system
      // rather than as twice the urgency — the quieter one is still recorded so that falling
      // back under the limit and rising again cannot resurrect it.
      const loudest = fresh[fresh.length - 1] as CrossedThreshold

      for (const record of fresh) {
        await this.record(entity, record, record === loudest)
      }

      for (const to of recipients) {
        await this.notifications.sendOperatorQuotaThreshold({
          to,
          businessName: operator.name,
          resourceLabel: loudest.label,
          current: loudest.current,
          limit: loudest.limit,
          threshold: loudest.threshold,
          billingUrl,
        })
      }
    }
  }

  /**
   * An operator with no live subscription still resolves to the default plan and still has
   * quotas, and has no subscription id to hang the record on. It falls back to the operator
   * row for the same reason `operator_subscription.upgrade_requested` does: that is the
   * entity an administrator opens when the record turns up in the log.
   */
  private auditEntity(operatorId: string, subscriptionId: string | null): AuditEntity {
    return subscriptionId
      ? { entityType: 'OperatorSubscription', entityId: subscriptionId }
      : { entityType: 'ParkingOperator', entityId: operatorId }
  }

  /**
   * Check-then-act, and knowingly so: AuditLog carries no uniqueness a conflicting insert
   * could bounce off, and adding one over a JSON payload to serialize two nudges would be a
   * schema change made for an email. The window is one concurrent create wide and its worst
   * outcome is a duplicate nudge, not a wrong number.
   */
  private async alreadyWarned(entity: AuditEntity, candidate: CrossedThreshold): Promise<boolean> {
    const existing = await this.prisma.auditLog.findFirst({
      where: {
        action: QUOTA_THRESHOLD_WARNED_ACTION,
        entityType: entity.entityType,
        entityId: entity.entityId,
        AND: [
          { payload: { path: ['resource'], equals: candidate.resource } },
          { payload: { path: ['threshold'], equals: candidate.threshold } },
        ],
      },
      select: { id: true },
    })
    return existing !== null
  }

  /**
   * Written before the mail goes out, so a send that hangs or crashes the process cannot
   * leave a threshold un-recorded and mail it again on the next create. `actorId` stays null:
   * nobody did this, the platform observed it.
   */
  private async record(
    entity: AuditEntity,
    crossed: CrossedThreshold,
    notified: boolean,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        action: QUOTA_THRESHOLD_WARNED_ACTION,
        entityType: entity.entityType,
        entityId: entity.entityId,
        payload: {
          resource: crossed.resource,
          threshold: crossed.threshold,
          current: crossed.current,
          limit: crossed.limit,
          notified,
        } satisfies Prisma.InputJsonValue,
      },
    })
  }

  /**
   * The people who can actually act on it. STAFF are excluded because billing is structurally
   * out of their reach — `scopesFor()` filters `org:billing.view` out of a staff membership —
   * so a nudge linking them to a page they cannot open is worse than no nudge. Lifecycle
   * filtering is the extension's: an archived or purged account is not a recipient.
   */
  private async adminEmails(operatorId: string): Promise<string[]> {
    const admins = await this.prisma.user.findMany({
      where: {
        operatorMemberships: { some: { operatorId, role: OperatorMemberRole.ADMIN } },
      },
      select: { email: true },
      orderBy: { createdAt: 'asc' },
    })

    return admins.map((admin) => admin.email)
  }
}
