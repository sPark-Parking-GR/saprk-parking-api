import { Injectable } from '@nestjs/common'
import { InviteStatus, LifecycleStatus, OperatorInviteKind, Prisma } from '@prisma/client'
import type {
  EffectiveEntitlements,
  Entitlements,
  OperatorUsage,
  SubscriptionFeature,
} from '@spark/types'
import {
  DefaultSubscriptionPlanMissingError,
  EntitlementLimitExceededError,
  SubscriptionDowngradeBlockedError,
  type EntitlementViolation,
} from '../common/errors/domain.errors'
import { UNCLAIMED_OPERATOR_ID } from '../ingestion/ingestion.constants'
import { PrismaService } from '../prisma/prisma.service'
import {
  entitlementOverrideSchema,
  entitlementsSchema,
  mergeEntitlements,
} from './entitlements.schema'
import {
  DEFAULT_PLAN_CODE,
  LIVE_SUBSCRIPTION_STATUSES,
  UNLIMITED_ENTITLEMENTS,
} from './subscriptions.constants'

/**
 * Resolves what an operator is allowed to do and refuses the operations that would exceed
 * it. Replaces the hardcoded `existing >= 1` cap in FacilitiesService.create and the
 * partial unique index that backed it (dropped in 20260803100000).
 *
 * QUOTA COUNTING PREDICATE. Only lifecycle-ACTIVE rows consume quota, which is exactly what
 * the dropped `Facility_operatorId_claimed_key` counted
 * (WHERE "operatorId" <> 'osm-unclaimed-operator' AND "lifecycleStatus" = 'ACTIVE'). Any
 * other choice changes behaviour rather than preserving it: counting archived rows too
 * would take a slot away from every operator who has ever archived a site, and counting
 * fewer would hand out a phantom slot. Archiving is the documented way to free a slot —
 * LifecycleService.archiveFacility says so — so a tenant who archives a site can open
 * another without purging data they may still be required to retain.
 *
 * The counts name `lifecycleStatus` EXPLICITLY rather than leaning on the Prisma lifecycle
 * extension's default filter, even though the extension would inject the identical term.
 * Two reasons: the extension backs off the moment a caller mentions lifecycleStatus, so
 * writing it changes nothing today; and a billing predicate that decides what a customer
 * may do must be legible at the call site and survive the extension being narrowed,
 * reordered or bypassed. Implicit is fine for hiding archived rows from a list; it is not
 * fine for the number a bill is argued over.
 *
 * CONCURRENCY. Every assert takes a client so it can run inside the caller's transaction.
 * With the unique index gone, the `SELECT ... FOR UPDATE` on the ParkingOperator row that
 * FacilitiesService.create already takes is the only thing serializing two simultaneous
 * creates — previously belt-and-suspenders behind the index, now the primary control.
 * Calling an assert outside that lock would reintroduce the check-then-act race.
 */
@Injectable()
export class EntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The synthetic owner of ~1,500 OSM/Google imports is an ingestion artifact, not a
   * customer: nobody signed up for it, nobody is billed for it, and the promotion pipeline
   * writes facilities under it in bulk. The dropped index exempted it by this exact name
   * and so does this, before any subscription is read — so an unconfigured catalog can
   * never wedge ingestion either.
   */
  isQuotaExempt(operatorId: string): boolean {
    return operatorId === UNCLAIMED_OPERATOR_ID
  }

  async assertCanCreateFacility(operatorId: string, tx?: Prisma.TransactionClient): Promise<void> {
    if (this.isQuotaExempt(operatorId)) return

    const client = tx ?? this.prisma
    const { maxFacilities } = await this.resolve(operatorId, client)
    if (maxFacilities === null) return

    const current = await this.countFacilities(client, operatorId)
    if (current >= maxFacilities) {
      throw new EntitlementLimitExceededError('facilities', maxFacilities, current)
    }
  }

  async assertCanCreateTariffPlan(
    operatorId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (this.isQuotaExempt(operatorId)) return

    const client = tx ?? this.prisma
    const { maxTariffPlans } = await this.resolve(operatorId, client)
    if (maxTariffPlans === null) return

    const current = await this.countTariffPlans(client, operatorId)
    if (current >= maxTariffPlans) {
      throw new EntitlementLimitExceededError('tariff plans', maxTariffPlans, current)
    }
  }

  async assertCanAddStaffSeat(operatorId: string, tx?: Prisma.TransactionClient): Promise<void> {
    if (this.isQuotaExempt(operatorId)) return

    const client = tx ?? this.prisma
    const { maxStaffSeats } = await this.resolve(operatorId, client)
    if (maxStaffSeats === null) return

    const current = await this.countStaffSeats(client, operatorId)
    if (current >= maxStaffSeats) {
      throw new EntitlementLimitExceededError('staff seats', maxStaffSeats, current)
    }
  }

  /**
   * The downgrade guard. Refuses a plan whose limits the operator's CURRENT usage already
   * breaks, naming every breach and the exact number to remove — see
   * SubscriptionDowngradeBlockedError for why refusing beats the two alternatives.
   */
  async assertUsageFitsEntitlements(
    operatorId: string,
    target: Entitlements,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (this.isQuotaExempt(operatorId)) return

    const usage = await this.usage(operatorId, tx)

    const violations: EntitlementViolation[] = []
    const check = (resource: string, limit: number | null, current: number): void => {
      if (limit !== null && current > limit) {
        violations.push({ resource, limit, current, remove: current - limit })
      }
    }

    check('facilities', target.maxFacilities, usage.facilities)
    check('tariff plans', target.maxTariffPlans, usage.tariffPlans)
    check('staff seats', target.maxStaffSeats, usage.staffSeats)

    if (violations.length > 0) throw new SubscriptionDowngradeBlockedError(violations)
  }

  async usage(operatorId: string, tx?: Prisma.TransactionClient): Promise<OperatorUsage> {
    const client = tx ?? this.prisma

    const [facilities, tariffPlans, staffSeats] = await Promise.all([
      this.countFacilities(client, operatorId),
      this.countTariffPlans(client, operatorId),
      this.countStaffSeats(client, operatorId),
    ])

    return { facilities, tariffPlans, staffSeats }
  }

  /**
   * Whether the operator's plan includes a capability at all, as distinct from how much of
   * it they have left. A refusal for "your plan does not include this" and one for "you have
   * used your last seat" are different products speaking, and the caller has to be able to
   * tell a customer which one happened.
   */
  async hasFeature(
    operatorId: string,
    feature: SubscriptionFeature,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { entitlements } = await this.resolveEffective(operatorId, tx)
    return entitlements.features.includes(feature)
  }

  /** The full picture for the admin surface: limits, where they came from, and usage. */
  async describe(
    operatorId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<EffectiveEntitlements & { usage: OperatorUsage }> {
    const client = tx ?? this.prisma

    const [effective, usage] = await Promise.all([
      this.resolveEffective(operatorId, client),
      this.usage(operatorId, client),
    ])

    return { ...effective, usage }
  }

  async resolveEffective(
    operatorId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<EffectiveEntitlements> {
    const client = tx ?? this.prisma

    if (this.isQuotaExempt(operatorId)) {
      return {
        operatorId,
        entitlements: UNLIMITED_ENTITLEMENTS,
        source: 'exempt',
        planCode: null,
        planName: null,
        subscriptionId: null,
        status: null,
      }
    }

    const subscription = await client.operatorSubscription.findFirst({
      where: { operatorId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
      include: { plan: true },
    })

    if (!subscription) {
      const fallback = await this.defaultPlan(client)
      return {
        operatorId,
        entitlements: entitlementsSchema.parse(fallback.entitlements),
        source: 'default',
        planCode: fallback.code,
        planName: fallback.name,
        subscriptionId: null,
        status: null,
      }
    }

    const base = entitlementsSchema.parse(subscription.plan.entitlements)
    const override =
      subscription.entitlementOverride === null
        ? null
        : entitlementOverrideSchema.parse(subscription.entitlementOverride)

    return {
      operatorId,
      entitlements: override ? mergeEntitlements(base, override) : base,
      source: override ? 'subscription+override' : 'subscription',
      planCode: subscription.plan.code,
      planName: subscription.plan.name,
      subscriptionId: subscription.id,
      status: subscription.status,
    }
  }

  private async resolve(
    operatorId: string,
    client: Prisma.TransactionClient,
  ): Promise<Entitlements> {
    const { entitlements } = await this.resolveEffective(operatorId, client)
    return entitlements
  }

  private async defaultPlan(
    client: Prisma.TransactionClient,
  ): Promise<{ code: string; name: string; entitlements: Prisma.JsonValue }> {
    const plan = await client.subscriptionPlan.findFirst({
      where: { code: DEFAULT_PLAN_CODE, lifecycleStatus: LifecycleStatus.ACTIVE },
      select: { code: true, name: true, entitlements: true },
    })
    if (!plan) throw new DefaultSubscriptionPlanMissingError(DEFAULT_PLAN_CODE)
    return plan
  }

  private countFacilities(client: Prisma.TransactionClient, operatorId: string): Promise<number> {
    return client.facility.count({
      where: { operatorId, lifecycleStatus: LifecycleStatus.ACTIVE },
    })
  }

  /**
   * `isActive` as well as lifecycle-ACTIVE, because deletePlan() soft-deletes by clearing
   * isActive rather than removing the row: a deactivated plan is the tariff equivalent of
   * an archived facility and must not keep occupying a paid slot.
   */
  private countTariffPlans(client: Prisma.TransactionClient, operatorId: string): Promise<number> {
    return client.tariffPlan.count({
      where: { operatorId, isActive: true, lifecycleStatus: LifecycleStatus.ACTIVE },
    })
  }

  /**
   * Seats in use are people who can sign in plus invitations that would let someone sign in
   * — an unredeemed invite is a seat already promised. Counting memberships alone would let
   * an operator on two seats mail out twenty links and discover the shortfall only as
   * whichever unlucky staff member redeemed nineteenth. Expired and revoked invites promise
   * nothing and are excluded.
   */
  private async countStaffSeats(
    client: Prisma.TransactionClient,
    operatorId: string,
  ): Promise<number> {
    const [members, pendingInvites] = await Promise.all([
      client.operatorMembership.count({ where: { operatorId } }),
      client.operatorInvite.count({
        where: {
          operatorId,
          kind: OperatorInviteKind.MEMBER,
          status: InviteStatus.PENDING,
          expiresAt: { gt: new Date() },
        },
      }),
    ])

    return members + pendingInvites
  }
}
