import { ForbiddenException, Injectable } from '@nestjs/common'
import {
  LifecycleStatus,
  Prisma,
  SubscriptionStatus,
  type DriverSubscriptionPlan,
} from '@prisma/client'
import { hasPlatformPermission, type AuthUser, type PlatformPermission } from '@spark/types'
import {
  LiveSubscriptionNotFoundError,
  SubscriptionPlanCodeTakenError,
  SubscriptionPlanInUseError,
  SubscriptionPlanNotFoundError,
} from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
import { SubscriptionBillingService } from '../subscription-billing/subscription-billing.service'
import type {
  ArchiveDriverPlanDto,
  AssignDriverSubscriptionDto,
  CreateDriverPlanDto,
  ListDriverPlansDto,
  SetDriverOverrideDto,
  UpdateDriverPlanDto,
} from './dto/driver-subscriptions.dto'
import {
  DriverEntitlementService,
  type EffectiveDriverEntitlements,
} from './driver-entitlement.service'
import {
  driverEntitlementOverrideSchema,
  driverEntitlementsSchema,
  normalizeDriverEntitlements,
  type DriverEntitlementOverride,
  type DriverEntitlements,
} from './driver-entitlements.schema'
import { LIVE_SUBSCRIPTION_STATUSES } from './subscriptions.constants'

const BILLING: PlatformPermission = 'platform:billing.manage'

export interface DriverPlanView {
  id: string
  code: string
  name: string
  description: string | null
  priceCents: number
  currency: string
  interval: DriverSubscriptionPlan['interval']
  entitlements: DriverEntitlements
  isPublic: boolean
  sortOrder: number
  lifecycleStatus: LifecycleStatus
  subscribers: number
}

export interface DriverSubscriptionView extends EffectiveDriverEntitlements {
  planId: string | null
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  trialEndsAt: Date | null
  cancelAtPeriodEnd: boolean
  providerSubscriptionId: string | null
  entitlementOverride: DriverEntitlementOverride | null
}

/**
 * The platform-administration face of driver billing, route-for-route the mirror of
 * SubscriptionAdminService. Every method re-checks `platform:billing.manage` that its
 * controller already gated on, per the both-layers authorization rule.
 *
 * Both mutation paths run under a `SELECT ... FOR UPDATE` on the User row. Nothing else on
 * the driver side reads that lock today, so it is not yet load-bearing the way the
 * ParkingOperator lock is; it is taken because it makes assign-vs-assign serialize on the
 * same row the partial unique index keys on, which turns a duplicate-live-subscription race
 * into a wait rather than a constraint violation surfaced to whichever admin lost.
 */
@Injectable()
export class DriverSubscriptionAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: DriverEntitlementService,
    private readonly billing: SubscriptionBillingService,
  ) {}

  async listPlans(actor: AuthUser, query: ListDriverPlansDto): Promise<DriverPlanView[]> {
    this.assertBilling(actor, 'view the driver plan catalog')

    const plans = await this.prisma.driverSubscriptionPlan.findMany({
      where: query.includeArchived ? {} : { lifecycleStatus: LifecycleStatus.ACTIVE },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      include: {
        _count: { select: { subscriptions: { where: this.liveStatusFilter() } } },
      },
    })

    return plans.map((plan) => this.toPlanView(plan, plan._count.subscriptions))
  }

  async createPlan(actor: AuthUser, dto: CreateDriverPlanDto): Promise<DriverPlanView> {
    this.assertBilling(actor, 'create driver subscription plans')

    try {
      const plan = await this.prisma.driverSubscriptionPlan.create({
        data: {
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          priceCents: dto.priceCents,
          currency: dto.currency,
          interval: dto.interval,
          entitlements: normalizeDriverEntitlements(dto.entitlements),
          isPublic: dto.isPublic,
          sortOrder: dto.sortOrder,
        },
      })

      await this.audit(
        actor,
        'driver_subscription_plan.created',
        'DriverSubscriptionPlan',
        plan.id,
        { code: plan.code },
      )

      return this.toPlanView(plan, 0)
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new SubscriptionPlanCodeTakenError(dto.code)
      }
      throw error
    }
  }

  /**
   * NO DOWNGRADE-USAGE GUARD, unlike the operator equivalent — and the omission is a
   * property of today's entitlement shape, not a decision to skip the check. Driver
   * entitlements are discounts, waivers and feature flags: nothing here caps a countable
   * resource the rider has already created, so there is no usage that a narrowed plan could
   * put retroactively over quota. Validation therefore reduces to parsing the new blob
   * through driverEntitlementsSchema.
   *
   * WHOEVER ADDS THE FIRST COUNTABLE DRIVER QUOTA — a bookings-per-month cap, a saved-vehicle
   * limit — must add the per-subscriber re-validation loop here that
   * SubscriptionAdminService.updatePlan runs (best-effort, deliberately outside the
   * per-subject lock), plus an assertUsageFitsEntitlements equivalent on
   * DriverEntitlementService, or a catalog edit will silently strand riders over a limit
   * that nothing then refuses.
   */
  async updatePlan(
    actor: AuthUser,
    id: string,
    dto: UpdateDriverPlanDto,
  ): Promise<DriverPlanView> {
    this.assertBilling(actor, 'edit driver subscription plans')

    const existing = await this.loadPlan(id)

    const plan = await this.prisma.driverSubscriptionPlan.update({
      where: { id: existing.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.interval !== undefined ? { interval: dto.interval } : {}),
        ...(dto.entitlements !== undefined
          ? { entitlements: normalizeDriverEntitlements(dto.entitlements) }
          : {}),
        ...(dto.isPublic !== undefined ? { isPublic: dto.isPublic } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    })

    await this.audit(actor, 'driver_subscription_plan.updated', 'DriverSubscriptionPlan', plan.id, {
      code: plan.code,
    })

    const subscribers = await this.prisma.driverSubscription.count({
      where: { planId: plan.id, ...this.liveStatusFilter() },
    })

    return this.toPlanView(plan, subscribers)
  }

  /**
   * There is no driver equivalent of the operator side's refusal to archive the default
   * plan: a rider with no live subscription resolves to FREE_TIER_DRIVER_ENTITLEMENTS in
   * code, so no catalog row is load-bearing for anyone who is not subscribed to it.
   */
  async archivePlan(
    actor: AuthUser,
    id: string,
    dto: ArchiveDriverPlanDto,
  ): Promise<DriverPlanView> {
    this.assertBilling(actor, 'archive driver subscription plans')

    const existing = await this.loadPlan(id)

    const subscribers = await this.prisma.driverSubscription.count({
      where: { planId: existing.id, ...this.liveStatusFilter() },
    })
    if (subscribers > 0) throw new SubscriptionPlanInUseError(existing.code, subscribers)

    const plan = await this.prisma.driverSubscriptionPlan.update({
      where: { id: existing.id },
      data: {
        lifecycleStatus: LifecycleStatus.ARCHIVED,
        lifecycleChangedAt: new Date(),
        lifecycleChangedBy: actor.id,
        lifecycleReason: dto.reason ?? null,
      },
    })

    await this.audit(
      actor,
      'driver_subscription_plan.archived',
      'DriverSubscriptionPlan',
      plan.id,
      { code: plan.code, reason: dto.reason ?? null },
    )

    return this.toPlanView(plan, 0)
  }

  async getDriverSubscription(actor: AuthUser, userId: string): Promise<DriverSubscriptionView> {
    this.assertBilling(actor, 'read driver entitlements')
    return this.describeDriver(userId)
  }

  async assignSubscription(
    actor: AuthUser,
    userId: string,
    dto: AssignDriverSubscriptionDto,
  ): Promise<DriverSubscriptionView> {
    this.assertBilling(actor, 'assign driver subscriptions')

    const superseded = await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, userId)

      const plan = await this.loadPlan(dto.planId, tx)
      const current = await this.liveSubscription(tx, userId)

      const override =
        dto.entitlementOverride === undefined
          ? this.parseOverride(current?.entitlementOverride ?? null)
          : dto.entitlementOverride === null
            ? null
            : driverEntitlementOverrideSchema.parse(dto.entitlementOverride)

      const terminal = dto.status === SubscriptionStatus.CANCELLED

      const data = {
        planId: plan.id,
        status: dto.status,
        currentPeriodEnd: dto.currentPeriodEnd ?? null,
        trialEndsAt: dto.trialEndsAt ?? null,
        cancelAtPeriodEnd: dto.cancelAtPeriodEnd,
        cancelledAt: terminal ? new Date() : null,
        entitlementOverride: this.overrideForWrite(override),
      }

      /**
       * A DB-only cancellation is not a cancellation. The provider goes on charging the
       * rider's card on its own schedule and nothing in this database points at the
       * subscription doing it, so the discrepancy is invisible until the rider complains.
       *
       * Two writes end a provider-billed agreement: cancelling it outright, and moving the
       * rider to a different plan — the second is a replacement, and leaving the old
       * subscription live would bill them for both.
       */
      const providerSubscriptionId =
        current?.providerSubscriptionId != null && (terminal || current.planId !== plan.id)
          ? current.providerSubscriptionId
          : null

      if (current && providerSubscriptionId && !terminal) {
        // Retired as its own CANCELLED row, keeping the provider id, rather than reused for
        // the new plan: the `subscription.deleted` our cancellation provokes must land on
        // this record and stop, not on the plan the administrator just granted.
        await tx.driverSubscription.update({
          where: { id: current.id },
          data: { status: SubscriptionStatus.CANCELLED, cancelledAt: new Date() },
        })
        await tx.driverSubscription.create({
          data: { ...data, userId, currentPeriodStart: new Date() },
        })
      } else if (current) {
        await tx.driverSubscription.update({ where: { id: current.id }, data })
      } else {
        await tx.driverSubscription.create({
          data: { ...data, userId, currentPeriodStart: new Date() },
        })
      }

      await this.audit(actor, 'driver_subscription.assigned', 'DriverSubscription', userId, {
        planCode: plan.code,
        status: dto.status,
        hasOverride: override !== null,
        cancelledProviderSubscriptionId: providerSubscriptionId,
      })

      return providerSubscriptionId
    })

    if (superseded) await this.cancelAtProvider(actor, userId, superseded)

    return this.describeDriver(userId)
  }

  /**
   * Outside the transaction on purpose: cancelling is a network call to the billing provider,
   * and holding the User row lock across it would let one slow Stripe response block every
   * other write on that rider.
   *
   * Best-effort, mirroring NotificationsService.safeSend — an administrator's override must
   * not be blocked by a transient provider outage, so the local write stands either way. But
   * "best-effort" is not "silent": a failure means the provider is still charging a rider this
   * database says is cancelled, which is exactly the discrepancy a billing reconciliation
   * needs on record rather than in a log line that rotates away.
   */
  private async cancelAtProvider(
    actor: AuthUser,
    userId: string,
    providerSubscriptionId: string,
  ): Promise<void> {
    const cancelled = await this.billing.cancelSubscriptionBestEffort(providerSubscriptionId, {
      reason: 'admin_assign',
      userId,
    })

    if (!cancelled) {
      await this.audit(
        actor,
        'driver_subscription.provider_cancel_failed',
        'DriverSubscription',
        userId,
        { providerSubscriptionId },
      )
    }
  }

  async setOverride(
    actor: AuthUser,
    userId: string,
    dto: SetDriverOverrideDto,
  ): Promise<DriverSubscriptionView> {
    this.assertBilling(actor, 'set driver entitlement overrides')

    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, userId)

      const current = await this.liveSubscription(tx, userId)
      // A deviation is a deviation FROM something. A free-tier rider has no agreement to
      // amend, so the fix is to assign them a plan first rather than to invent one here.
      if (!current) throw new LiveSubscriptionNotFoundError(userId)

      const override =
        dto.entitlementOverride === null
          ? null
          : driverEntitlementOverrideSchema.parse(dto.entitlementOverride)

      await tx.driverSubscription.update({
        where: { id: current.id },
        data: { entitlementOverride: this.overrideForWrite(override) },
      })

      await this.audit(actor, 'driver_subscription.override_set', 'DriverSubscription', userId, {
        cleared: override === null,
      })
    })

    return this.describeDriver(userId)
  }

  private async describeDriver(userId: string): Promise<DriverSubscriptionView> {
    const [effective, subscription] = await Promise.all([
      this.entitlements.resolveEffective(userId),
      this.prisma.driverSubscription.findFirst({
        where: { userId, ...this.liveStatusFilter() },
      }),
    ])

    return {
      ...effective,
      planId: subscription?.planId ?? null,
      currentPeriodStart: subscription?.currentPeriodStart ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      trialEndsAt: subscription?.trialEndsAt ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      providerSubscriptionId: subscription?.providerSubscriptionId ?? null,
      entitlementOverride: this.parseOverride(subscription?.entitlementOverride ?? null),
    }
  }

  private liveSubscription(tx: Prisma.TransactionClient, userId: string) {
    return tx.driverSubscription.findFirst({
      where: { userId, ...this.liveStatusFilter() },
    })
  }

  private liveStatusFilter() {
    return { status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } }
  }

  private async loadPlan(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DriverSubscriptionPlan> {
    const client = tx ?? this.prisma
    const plan = await client.driverSubscriptionPlan.findFirst({
      where: { id, lifecycleStatus: LifecycleStatus.ACTIVE },
    })
    if (!plan) throw new SubscriptionPlanNotFoundError(id)
    return plan
  }

  private parseOverride(value: Prisma.JsonValue | null): DriverEntitlementOverride | null {
    return value === null ? null : driverEntitlementOverrideSchema.parse(value)
  }

  private overrideForWrite(
    override: DriverEntitlementOverride | null,
  ): Prisma.InputJsonValue | typeof Prisma.DbNull {
    return override === null ? Prisma.DbNull : (override as Prisma.InputJsonValue)
  }

  private lockUser(tx: Prisma.TransactionClient, userId: string): Promise<unknown> {
    return tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`
  }

  private toPlanView(plan: DriverSubscriptionPlan, subscribers: number): DriverPlanView {
    return {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      description: plan.description,
      priceCents: plan.priceCents,
      currency: plan.currency,
      interval: plan.interval,
      entitlements: driverEntitlementsSchema.parse(plan.entitlements),
      isPublic: plan.isPublic,
      sortOrder: plan.sortOrder,
      lifecycleStatus: plan.lifecycleStatus,
      subscribers,
    }
  }

  private async audit(
    actor: AuthUser,
    action: string,
    entityType: 'DriverSubscriptionPlan' | 'DriverSubscription',
    entityId: string,
    payload: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: { actorId: actor.id, actorRole: actor.role, action, entityType, entityId, payload },
    })
  }

  private assertBilling(actor: AuthUser, action: string): void {
    if (!hasPlatformPermission(actor.role, BILLING)) {
      throw new ForbiddenException(`Only billing administrators may ${action}`)
    }
  }
}
