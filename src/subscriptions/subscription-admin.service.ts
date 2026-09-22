import { ForbiddenException, Injectable } from '@nestjs/common'
import { LifecycleStatus, Prisma, SubscriptionStatus, type SubscriptionPlan } from '@prisma/client'
import {
  hasPlatformPermission,
  type AuthUser,
  type EntitlementOverride,
  type OperatorSubscriptionView,
  type PlanView,
  type PlatformPermission,
} from '@spark/types'
import {
  SubscriptionPlanCodeTakenError,
  SubscriptionPlanInUseError,
  SubscriptionPlanNotFoundError,
} from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
import { SubscriptionBillingService } from '../subscription-billing/subscription-billing.service'
import type {
  ArchivePlanDto,
  AssignSubscriptionDto,
  CreatePlanDto,
  ListPlansDto,
  SetOverrideDto,
  UpdatePlanDto,
} from './dto/subscriptions.dto'
import { EntitlementService } from './entitlement.service'
import {
  entitlementOverrideSchema,
  entitlementsSchema,
  mergeEntitlements,
  normalizeEntitlements,
} from './entitlements.schema'
import { DEFAULT_PLAN_CODE, LIVE_SUBSCRIPTION_STATUSES } from './subscriptions.constants'

const BILLING: PlatformPermission = 'platform:billing.manage'

/**
 * The platform-administration face of billing. Every method re-checks
 * `platform:billing.manage` that its controller already gated on, per the both-layers
 * authorization rule the lifecycle and operators services follow.
 *
 * Both mutation paths run under a `SELECT ... FOR UPDATE` on the ParkingOperator row. That
 * is the same lock FacilitiesService.create takes, and taking it here is what stops a
 * facility create from committing between this service reading current usage and writing
 * the smaller limit — otherwise a downgrade and a create could interleave into exactly the
 * over-quota state the guard exists to prevent.
 */
@Injectable()
export class SubscriptionAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly billing: SubscriptionBillingService,
  ) {}

  async listPlans(actor: AuthUser, query: ListPlansDto): Promise<PlanView[]> {
    this.assertBilling(actor, 'view the plan catalog')

    const plans = await this.prisma.subscriptionPlan.findMany({
      where: query.includeArchived ? {} : { lifecycleStatus: LifecycleStatus.ACTIVE },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      include: {
        _count: { select: { subscriptions: { where: this.liveStatusFilter() } } },
      },
    })

    return plans.map((plan) => this.toPlanView(plan, plan._count.subscriptions))
  }

  async createPlan(actor: AuthUser, dto: CreatePlanDto): Promise<PlanView> {
    this.assertBilling(actor, 'create subscription plans')

    try {
      const plan = await this.prisma.subscriptionPlan.create({
        data: {
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          priceCents: dto.priceCents,
          currency: dto.currency,
          interval: dto.interval,
          entitlements: normalizeEntitlements(dto.entitlements),
          isPublic: dto.isPublic,
          sortOrder: dto.sortOrder,
        },
      })

      await this.audit(actor, 'subscription_plan.created', 'SubscriptionPlan', plan.id, {
        code: plan.code,
      })

      return this.toPlanView(plan, 0)
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new SubscriptionPlanCodeTakenError(dto.code)
      }
      throw error
    }
  }

  /**
   * Editing a live plan's entitlements re-validates every subscriber against the new terms
   * first, so a catalog edit cannot do what an individual downgrade is refused for: the
   * refusal names the tenant that would break, rather than letting an admin discover it
   * through support tickets.
   *
   * Deliberately NOT under the per-operator lock the single-operator paths take. Locking
   * every subscriber's row in one transaction is a deadlock waiting to happen against the
   * facility-create path that locks one, so this check is a best-effort gate rather than a
   * serialization point. The consequence is bounded and self-correcting: a facility created
   * concurrently with a plan edit can leave one tenant one over the new limit, where the
   * per-operator asserts then refuse further creates until they are back within it. No
   * customer data is ever removed to make the numbers agree.
   */
  async updatePlan(actor: AuthUser, id: string, dto: UpdatePlanDto): Promise<PlanView> {
    this.assertBilling(actor, 'edit subscription plans')

    const existing = await this.loadPlan(id)

    if (dto.entitlements) {
      const next = normalizeEntitlements(dto.entitlements)
      const subscriptions = await this.prisma.operatorSubscription.findMany({
        where: { planId: id, ...this.liveStatusFilter() },
        select: { operatorId: true, entitlementOverride: true },
      })

      for (const subscription of subscriptions) {
        const override = this.parseOverride(subscription.entitlementOverride)
        await this.entitlements.assertUsageFitsEntitlements(
          subscription.operatorId,
          override ? mergeEntitlements(next, override) : next,
        )
      }
    }

    const plan = await this.prisma.subscriptionPlan.update({
      where: { id: existing.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.interval !== undefined ? { interval: dto.interval } : {}),
        ...(dto.entitlements !== undefined
          ? { entitlements: normalizeEntitlements(dto.entitlements) }
          : {}),
        ...(dto.isPublic !== undefined ? { isPublic: dto.isPublic } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    })

    await this.audit(actor, 'subscription_plan.updated', 'SubscriptionPlan', plan.id, {
      code: plan.code,
    })

    const subscribers = await this.prisma.operatorSubscription.count({
      where: { planId: plan.id, ...this.liveStatusFilter() },
    })

    return this.toPlanView(plan, subscribers)
  }

  async archivePlan(actor: AuthUser, id: string, dto: ArchivePlanDto): Promise<PlanView> {
    this.assertBilling(actor, 'archive subscription plans')

    const existing = await this.loadPlan(id)

    // Everything without a live subscription resolves to the default plan, so archiving it
    // would make entitlements unresolvable for every such operator at once.
    if (existing.code === DEFAULT_PLAN_CODE) {
      throw new SubscriptionPlanInUseError(existing.code, 0)
    }

    const subscribers = await this.prisma.operatorSubscription.count({
      where: { planId: existing.id, ...this.liveStatusFilter() },
    })
    if (subscribers > 0) throw new SubscriptionPlanInUseError(existing.code, subscribers)

    const plan = await this.prisma.subscriptionPlan.update({
      where: { id: existing.id },
      data: {
        lifecycleStatus: LifecycleStatus.ARCHIVED,
        lifecycleChangedAt: new Date(),
        lifecycleChangedBy: actor.id,
        lifecycleReason: dto.reason ?? null,
      },
    })

    await this.audit(actor, 'subscription_plan.archived', 'SubscriptionPlan', plan.id, {
      code: plan.code,
      reason: dto.reason ?? null,
    })

    return this.toPlanView(plan, 0)
  }

  async getOperatorSubscription(
    actor: AuthUser,
    operatorId: string,
  ): Promise<OperatorSubscriptionView> {
    this.assertBilling(actor, 'read operator entitlements')
    return this.describeOperator(operatorId)
  }

  async assignSubscription(
    actor: AuthUser,
    operatorId: string,
    dto: AssignSubscriptionDto,
  ): Promise<OperatorSubscriptionView> {
    this.assertBilling(actor, 'assign operator subscriptions')

    const superseded = await this.prisma.$transaction(async (tx) => {
      await this.lockOperator(tx, operatorId)

      const plan = await this.loadPlan(dto.planId, tx)
      const current = await this.liveSubscription(tx, operatorId)

      const override =
        dto.entitlementOverride === undefined
          ? this.parseOverride(current?.entitlementOverride ?? null)
          : dto.entitlementOverride === null
            ? null
            : entitlementOverrideSchema.parse(dto.entitlementOverride)

      await this.assertFitsAfterChange(tx, operatorId, plan, dto.status, override)

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
       * A DB-only cancellation is not a cancellation. Now that an operator can reach a real
       * provider subscription through self-serve checkout, the provider goes on charging
       * their card on its own schedule and nothing in this database points at the agreement
       * doing it — a discrepancy that stays invisible until the customer complains.
       *
       * Two writes end a provider-billed agreement: cancelling it outright, and moving the
       * tenant to a different plan — the second is a replacement, and leaving the old
       * subscription live would bill them for both. Null when the current row was assigned by
       * hand and never billed, which is every row that predates this phase.
       */
      const providerSubscriptionId =
        current?.providerSubscriptionId != null && (terminal || current.planId !== plan.id)
          ? current.providerSubscriptionId
          : null

      if (current && providerSubscriptionId && !terminal) {
        // Retired as its own CANCELLED row, keeping the provider id, rather than reused for
        // the new plan: the `subscription.deleted` our cancellation provokes must land on
        // this record and stop, not on the plan the administrator just granted.
        await tx.operatorSubscription.update({
          where: { id: current.id },
          data: { status: SubscriptionStatus.CANCELLED, cancelledAt: new Date() },
        })
        await tx.operatorSubscription.create({
          data: { ...data, operatorId, currentPeriodStart: new Date() },
        })
      } else if (current) {
        await tx.operatorSubscription.update({ where: { id: current.id }, data })
      } else {
        await tx.operatorSubscription.create({
          data: { ...data, operatorId, currentPeriodStart: new Date() },
        })
      }

      await this.audit(
        actor,
        'operator_subscription.assigned',
        'OperatorSubscription',
        operatorId,
        {
          planCode: plan.code,
          status: dto.status,
          hasOverride: override !== null,
          cancelledProviderSubscriptionId: providerSubscriptionId,
        },
      )

      return providerSubscriptionId
    })

    if (superseded) await this.cancelAtProvider(actor, operatorId, superseded)

    return this.describeOperator(operatorId)
  }

  /**
   * Outside the transaction on purpose: cancelling is a network call to the billing provider,
   * and holding the ParkingOperator row lock across it would let one slow Stripe response
   * block every other write on that tenant — facility creates included, since they take the
   * same lock.
   *
   * Best-effort, mirroring NotificationsService.safeSend — an administrator's override must
   * not be blocked by a transient provider outage, so the local write stands either way. But
   * "best-effort" is not "silent": a failure means the provider is still charging a tenant
   * this database says is cancelled, which is exactly the discrepancy a billing
   * reconciliation needs on record rather than in a log line that rotates away.
   */
  private async cancelAtProvider(
    actor: AuthUser,
    operatorId: string,
    providerSubscriptionId: string,
  ): Promise<void> {
    const cancelled = await this.billing.cancelSubscriptionBestEffort(providerSubscriptionId, {
      reason: 'admin_assign',
      operatorId,
    })

    if (!cancelled) {
      await this.audit(
        actor,
        'operator_subscription.provider_cancel_failed',
        'OperatorSubscription',
        operatorId,
        { providerSubscriptionId },
      )
    }
  }

  /**
   * A negotiated deviation on its own. Lowering a limit here is a downgrade by another
   * name, so it runs the identical guard rather than a laxer one.
   */
  async setOverride(
    actor: AuthUser,
    operatorId: string,
    dto: SetOverrideDto,
  ): Promise<OperatorSubscriptionView> {
    this.assertBilling(actor, 'set entitlement overrides')

    await this.prisma.$transaction(async (tx) => {
      await this.lockOperator(tx, operatorId)

      const current = await this.liveSubscription(tx, operatorId)
      if (!current) throw new SubscriptionPlanNotFoundError(operatorId)

      const override =
        dto.entitlementOverride === null
          ? null
          : entitlementOverrideSchema.parse(dto.entitlementOverride)

      const plan = await this.loadPlan(current.planId, tx)
      await this.assertFitsAfterChange(tx, operatorId, plan, current.status, override)

      await tx.operatorSubscription.update({
        where: { id: current.id },
        data: { entitlementOverride: this.overrideForWrite(override) },
      })

      await this.audit(
        actor,
        'operator_subscription.override_set',
        'OperatorSubscription',
        operatorId,
        {
          cleared: override === null,
        },
      )
    })

    return this.describeOperator(operatorId)
  }

  /**
   * The guard runs against whatever would be IN EFFECT after the change, not against the
   * plan in isolation. Cancelling is included on purpose: a cancelled subscription falls
   * back to the default plan, so cancelling a large plan is a downgrade to Starter and has
   * to be refused for the same reason an explicit downgrade is.
   */
  private async assertFitsAfterChange(
    tx: Prisma.TransactionClient,
    operatorId: string,
    plan: SubscriptionPlan,
    status: SubscriptionStatus,
    override: EntitlementOverride | null,
  ): Promise<void> {
    if (status === SubscriptionStatus.CANCELLED) {
      const fallback = await tx.subscriptionPlan.findFirst({
        where: { code: DEFAULT_PLAN_CODE, lifecycleStatus: LifecycleStatus.ACTIVE },
        select: { entitlements: true },
      })
      if (!fallback) return
      await this.entitlements.assertUsageFitsEntitlements(
        operatorId,
        entitlementsSchema.parse(fallback.entitlements),
        tx,
      )
      return
    }

    const base = entitlementsSchema.parse(plan.entitlements)
    await this.entitlements.assertUsageFitsEntitlements(
      operatorId,
      override ? mergeEntitlements(base, override) : base,
      tx,
    )
  }

  private async describeOperator(operatorId: string): Promise<OperatorSubscriptionView> {
    const [described, subscription] = await Promise.all([
      this.entitlements.describe(operatorId),
      this.prisma.operatorSubscription.findFirst({
        where: { operatorId, ...this.liveStatusFilter() },
      }),
    ])

    return {
      ...described,
      planId: subscription?.planId ?? null,
      currentPeriodStart: subscription?.currentPeriodStart ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      trialEndsAt: subscription?.trialEndsAt ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      providerSubscriptionId: subscription?.providerSubscriptionId ?? null,
      entitlementOverride: this.parseOverride(subscription?.entitlementOverride ?? null),
    }
  }

  private liveSubscription(tx: Prisma.TransactionClient, operatorId: string) {
    return tx.operatorSubscription.findFirst({
      where: { operatorId, ...this.liveStatusFilter() },
    })
  }

  private liveStatusFilter() {
    return { status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } }
  }

  private async loadPlan(id: string, tx?: Prisma.TransactionClient): Promise<SubscriptionPlan> {
    const client = tx ?? this.prisma
    const plan = await client.subscriptionPlan.findFirst({
      where: { id, lifecycleStatus: LifecycleStatus.ACTIVE },
    })
    if (!plan) throw new SubscriptionPlanNotFoundError(id)
    return plan
  }

  private parseOverride(value: Prisma.JsonValue | null): EntitlementOverride | null {
    return value === null ? null : entitlementOverrideSchema.parse(value)
  }

  private overrideForWrite(
    override: EntitlementOverride | null,
  ): Prisma.InputJsonValue | typeof Prisma.DbNull {
    return override === null ? Prisma.DbNull : (override as Prisma.InputJsonValue)
  }

  private lockOperator(tx: Prisma.TransactionClient, operatorId: string): Promise<unknown> {
    return tx.$executeRaw`SELECT id FROM "ParkingOperator" WHERE id = ${operatorId} FOR UPDATE`
  }

  private toPlanView(plan: SubscriptionPlan, subscribers: number): PlanView {
    return {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      description: plan.description,
      priceCents: plan.priceCents,
      currency: plan.currency,
      interval: plan.interval,
      entitlements: entitlementsSchema.parse(plan.entitlements),
      isPublic: plan.isPublic,
      sortOrder: plan.sortOrder,
      lifecycleStatus: plan.lifecycleStatus,
      subscribers,
    }
  }

  private async audit(
    actor: AuthUser,
    action: string,
    entityType: 'SubscriptionPlan' | 'OperatorSubscription',
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
