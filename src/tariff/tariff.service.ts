import { Injectable } from '@nestjs/common'
import { FacilityKind, LifecycleStatus, Prisma } from '@prisma/client'
import type {
  RateCap,
  RateTier,
  RateWindow,
  TariffPlan,
  TariffRate,
  VehicleType,
} from '@prisma/client'
import type { AuthUser } from '@spark/types'
import {
  OperatorScopeService,
  targetOperatorId,
  type OperatorScope,
} from '../common/authz/operator-scope.service'
import { LifecycleService } from '../lifecycle/lifecycle.service'
import { initialManagerIds } from '../managers/initial-managers'
import { anyLifecycleStatus } from '../prisma/lifecycle.extension'
import {
  DefaultTariffRequiredError,
  DomainError,
  InvalidTariffScheduleError,
  NoApplicableTariffError,
  FacilityNotFoundError,
  TariffPlanNotFoundError,
} from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
import { DriverEntitlementService } from '../subscriptions/driver-entitlement.service'
import { EntitlementService } from '../subscriptions/entitlement.service'
import { QuotaThresholdService } from '../subscriptions/quota-threshold.service'
import { compileDraft } from './draft-compiler'
import { priceStay } from './pricing-engine'
import { validateRateGrid, validateSchedule } from './schedule-validation'
import {
  SCOPE_FROM_PRISMA,
  SCOPE_TO_PRISMA,
  UNIT_FROM_PRISMA,
  UNIT_TO_PRISMA,
  VEHICLE_FROM_PRISMA,
  VEHICLE_TO_PRISMA,
  type ListTariffPlansDto,
  type SimulateDto,
  type TariffDraftDto,
} from './dto/tariff.dto'
import {
  QUOTE_TTL_MINUTES,
  type CompiledPlan,
  type PinnedPriceRequest,
  type PinnedPriceResult,
  type PlanAssignments,
  type PriceQuote,
  type QuoteRequest,
  type SimulateResult,
  type TariffPlanDetail,
  type TariffPlanListItem,
} from './tariff.types'

type PlanWithSchedule = TariffPlan & {
  tiers: (RateTier & { rates: TariffRate[] })[]
  windows: (RateWindow & { rates: TariffRate[] })[]
  caps: RateCap[]
}

const scheduleInclude = {
  tiers: { include: { rates: true }, orderBy: { fromMinute: 'asc' } },
  windows: { include: { rates: true } },
  caps: true,
} satisfies Prisma.TariffPlanInclude

/**
 * A facility's assigned plan applies to a quote only when it is active, the quote
 * instant sits inside the plan's validity window, and the plan prices the requested
 * vehicle class (empty vehicleTypes = all classes). The lifecycle gate matters here
 * because the pricing paths load plans through nested includes, which the default
 * lifecycle filter (src/prisma/lifecycle.extension.ts) does not intercept — this
 * in-memory check is what keeps an archived plan from pricing a new quote.
 */
export function isPlanApplicable(plan: TariffPlan, at: Date, vehicleType: VehicleType): boolean {
  if (plan.lifecycleStatus !== LifecycleStatus.ACTIVE) return false
  if (!plan.isActive) return false
  if (plan.validFrom && plan.validFrom > at) return false
  if (plan.validTo && plan.validTo < at) return false
  if (plan.vehicleTypes.length > 0 && !plan.vehicleTypes.includes(vehicleType)) return false
  return true
}

/**
 * A plan can only serve as an operator's catch-all default when its own `vehicleTypes`
 * is empty (empty = "prices every vehicle type"); a type-restricted plan can't fall back
 * for the types it doesn't price.
 */
export function canBeDefault(vehicleTypes: VehicleType[]): boolean {
  return vehicleTypes.length === 0
}

/**
 * Guards that an assignment row's target vehicle-type slot doesn't contradict what the
 * plan is designed to price (its own `vehicleTypes`, empty = "all"): the plan must price
 * all types or include that concrete type. Returns a human-readable reason when the
 * pairing is invalid, else null.
 */
export function assignmentMismatchReason(
  planVehicleTypes: VehicleType[],
  slot: VehicleType,
): string | null {
  if (planVehicleTypes.length > 0 && !planVehicleTypes.includes(slot)) {
    return `plan does not price vehicle type ${slot}`
  }
  return null
}

@Injectable()
export class TariffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operatorScope: OperatorScopeService,
    private readonly entitlements: EntitlementService,
    private readonly lifecycle: LifecycleService,
    private readonly driverEntitlements: DriverEntitlementService,
    private readonly quotaThresholds: QuotaThresholdService,
  ) {}

  async computeQuote(request: QuoteRequest): Promise<PriceQuote> {
    const { facilityId, startsAt, endsAt, vehicleType } = request

    if (endsAt <= startsAt) {
      throw new DomainError('endsAt must be after startsAt')
    }

    const facility = await this.prisma.facility.findFirst({
      where: { id: facilityId, isActive: true, isPublished: true, kind: FacilityKind.BUSINESS },
      include: {
        tariffAssignments: {
          where: { vehicleType },
          include: { tariffPlan: { include: scheduleInclude } },
        },
      },
    })

    if (!facility) throw new FacilityNotFoundError(facilityId)

    let plan: PlanWithSchedule | null = facility.tariffAssignments[0]?.tariffPlan ?? null
    if (!plan && facility.operatorId !== null) {
      plan = await this.prisma.tariffPlan.findFirst({
        where: { operatorId: facility.operatorId, isDefault: true, isActive: true },
        include: scheduleInclude,
      })
    }
    if (!plan || !isPlanApplicable(plan, startsAt, vehicleType)) {
      throw new NoApplicableTariffError(facilityId)
    }

    const compiled = compilePlan(plan)
    const [commissionBps, bookingDiscountBps] = await Promise.all([
      this.commissionBpsFor(facility.operatorId),
      this.bookingDiscountBpsFor(request.userId),
    ])
    const result = priceStay(startsAt, endsAt, compiled, commissionBps, bookingDiscountBps)

    const durationMinutes = Math.ceil((endsAt.getTime() - startsAt.getTime()) / 60_000)
    const expiresAt = new Date(Date.now() + QUOTE_TTL_MINUTES * 60_000)

    return {
      facilityId,
      startsAt,
      endsAt,
      durationMinutes,
      vehicleType,
      lineItems: result.lineItems,
      totalCents: result.totalCents,
      discountCents: result.discountCents,
      currency: compiled.currency,
      expiresAt,
      planId: compiled.id,
      planVersion: compiled.version,
    }
  }

  /**
   * Prices a stay against an exact (planId, version) pin instead of whatever plan a
   * facility resolves to today. This is the check-out side of the pin a quote takes:
   * both ends of a stay must be priced by the same schedule.
   *
   * Returns null when the pin no longer resolves — the plan row is gone, or it has been
   * edited since (updatePlan REPLACES tiers/windows/rates and bumps version, so the
   * priced schedule of the old version no longer exists anywhere). Pricing against the
   * current revision instead would silently bill rates the customer never agreed to, so
   * the caller is told the pin is stale rather than handed a plausible wrong number.
   *
   * Plan applicability (isActive, validity window, vehicle classes) is deliberately not
   * re-checked: those gate whether a plan may price a NEW booking, and an operator
   * retiring a plan must not change what an already-priced stay costs.
   */
  async priceWithPinnedPlan(request: PinnedPriceRequest): Promise<PinnedPriceResult | null> {
    const { planId, planVersion, startsAt, endsAt } = request

    if (endsAt <= startsAt) throw new DomainError('endsAt must be after startsAt')

    // Explicit lifecycle opt-out: the pin records a historical pricing fact, and an
    // in-flight stay must still reprice at check-out even if its plan was archived or
    // tombstoned mid-stay. Only a physical purge makes the pin unresolvable, which the
    // null return already reports.
    const plan = await this.prisma.tariffPlan.findFirst({
      where: { id: planId, version: planVersion, lifecycleStatus: anyLifecycleStatus() },
      include: scheduleInclude,
    })
    if (!plan) return null

    const compiled = compilePlan(plan)
    const [commissionBps, bookingDiscountBps] = await Promise.all([
      this.commissionBpsFor(plan.operatorId),
      this.bookingDiscountBpsFor(request.userId),
    ])
    const result = priceStay(startsAt, endsAt, compiled, commissionBps, bookingDiscountBps)

    return {
      totalCents: result.totalCents,
      discountCents: result.discountCents,
      currency: compiled.currency,
      billableMinutes: result.billableMinutes,
      commissionCents: result.commissionCents,
    }
  }

  /**
   * The platform's take-rate for whoever owns what is being priced, read from the operator's
   * subscription rather than from the tariff plan: the tariff says what the DRIVER pays, the
   * subscription says what the platform keeps of it, and conflating them would make a
   * commission change require an operator to re-publish their prices.
   *
   * A facility with no operator is an un-onboarded import that nobody is billed through, so
   * there is no agreement to take a share under.
   */
  private async commissionBpsFor(operatorId: string | null): Promise<number> {
    if (operatorId === null) return 0
    const { entitlements } = await this.entitlements.resolveEffective(operatorId)
    return entitlements.commissionBps
  }

  /**
   * The rider's own perk, the mirror of commissionBpsFor on the other side of the same
   * booking: the operator's subscription says what the platform keeps, the rider's says what
   * the rider is spared. `null` where no rider is identified — that is the unauthenticated
   * quote preview, which prices a stay rather than a person's stay, and it is the reason
   * userId is optional on QuoteRequest.
   *
   * `bookingFeeWaived` IS NOT WIRED HERE, AND THAT IS DELIBERATE. This codebase charges no
   * booking fee anywhere — there is no fee line item in pricing-engine.ts, no fee column on
   * Booking, and nothing that adds one — so there is literally nothing for the entitlement to
   * waive. It stays schema'd and resolved into EffectiveDriverEntitlements so a plan can
   * already promise it, and it will be consumed at the point a real fee model introduces the
   * fee. Do not invent a placeholder fee here so that the flag has something to switch off:
   * that would make riders pay a charge nobody decided to levy.
   */
  private async bookingDiscountBpsFor(userId: string | undefined): Promise<number | null> {
    if (!userId) return null
    const { entitlements } = await this.driverEntitlements.resolveEffective(userId)
    return entitlements.bookingDiscountBps
  }

  /**
   * Quote totals for many facilities in exactly two queries; pricing runs in memory. Each
   * facility resolves to its per-vehicle-type row when present, else its operator's active
   * default plan. Defaults are batched by distinct operator (one findMany), never per
   * facility. Facilities with no covering/applicable plan, or whose plan can't price, are
   * omitted (caller treats as no price).
   */
  async computeTotalsByFacility(
    facilityIds: string[],
    startsAt: Date,
    endsAt: Date,
    vehicleType: VehicleType,
  ): Promise<Map<string, number>> {
    if (facilityIds.length === 0 || endsAt <= startsAt) return new Map()

    const facilities = await this.prisma.facility.findMany({
      where: { id: { in: facilityIds } },
      select: {
        id: true,
        operatorId: true,
        tariffAssignments: {
          where: { vehicleType },
          include: { tariffPlan: { include: scheduleInclude } },
        },
      },
    })

    // Operator-less facilities never have a default plan to resolve — only their own
    // explicit per-vehicle-type assignment (already fetched above) can price them.
    const operatorIds = [
      ...new Set(facilities.map((f) => f.operatorId).filter((id): id is string => id !== null)),
    ]
    const defaults = operatorIds.length
      ? await this.prisma.tariffPlan.findMany({
          where: { operatorId: { in: operatorIds }, isDefault: true, isActive: true },
          include: scheduleInclude,
        })
      : []
    const defaultsByOperator = new Map(defaults.map((d) => [d.operatorId, d]))

    const totals = new Map<string, number>()
    for (const facility of facilities) {
      const plan =
        facility.tariffAssignments[0]?.tariffPlan ??
        (facility.operatorId !== null ? defaultsByOperator.get(facility.operatorId) : null) ??
        null
      if (!plan || !isPlanApplicable(plan, startsAt, vehicleType)) continue
      try {
        // No commission and no rider discount: this prices the SCHEDULE for a map full of
        // facilities, not a stay anyone is billed for, and the caller is often anonymous.
        const result = priceStay(startsAt, endsAt, compilePlan(plan), 0, null)
        totals.set(facility.id, result.totalCents)
      } catch {
        // Incomplete/invalid schedule: omit this facility from priced results.
      }
    }
    return totals
  }

  async listPlans(
    user: AuthUser,
    query: ListTariffPlansDto,
  ): Promise<{ items: TariffPlanListItem[] }> {
    const scope = await this.operatorScope.resolve(user)

    const plans = await this.prisma.tariffPlan.findMany({
      where: this.listWhere(scope, user, query),
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        operatorId: true,
        operator: { select: { name: true } },
        name: true,
        isActive: true,
        isDefault: true,
        validFrom: true,
        validTo: true,
        vehicleTypes: true,
        version: true,
        updatedAt: true,
      },
    })

    const items = plans.map((p) => ({
      id: p.id,
      operatorId: p.operatorId,
      operatorName: p.operator.name,
      name: p.name,
      isActive: p.isActive,
      isDefault: p.isDefault,
      validFrom: p.validFrom,
      validTo: p.validTo,
      vehicleTypes: p.vehicleTypes.map((v) => VEHICLE_FROM_PRISMA[v]),
      version: p.version,
      updatedAt: p.updatedAt,
    }))

    return { items }
  }

  // A supplied operatorId narrows a platform admin's cross-operator list. For an operator
  // caller it is ignored outright: their scope term already restricts them, and honoring it
  // would read as a working filter on plans they can never see.
  private listWhere(
    scope: OperatorScope,
    user: AuthUser,
    query: ListTariffPlansDto,
  ): Prisma.TariffPlanWhereInput {
    return {
      ...this.operatorScope.tariffPlanScopeWhere(scope, user),
      ...(scope.kind === 'platform' && query.operatorId
        ? { AND: [{ operatorId: query.operatorId }] }
        : {}),
    }
  }

  async getPlanDetail(user: AuthUser, planId: string): Promise<TariffPlanDetail> {
    await this.assertPlanOwned(user, planId)

    const plan = await this.prisma.tariffPlan.findFirstOrThrow({
      where: { id: planId },
      include: scheduleInclude,
    })

    return this.toPlanDetail(plan)
  }

  async createPlan(user: AuthUser, draft: TariffDraftDto): Promise<TariffPlanDetail> {
    const scope = await this.operatorScope.resolve(user)
    this.validateDraft(draft)

    const operatorId = targetOperatorId(scope, draft.operatorId)

    const operator = await this.prisma.parkingOperator.findUnique({
      where: { id: operatorId },
      select: { id: true },
    })
    if (!operator) throw new DomainError('operatorId required')

    const vehicleTypes = draft.vehicleTypes.map((v) => VEHICLE_TO_PRISMA[v])

    if (draft.isDefault && !canBeDefault(vehicleTypes)) {
      throw new DomainError(
        'A default plan must price every vehicle type (leave vehicleTypes empty).',
      )
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // Same lock-then-check shape as FacilitiesService.create, and for the same reason:
      // no unique index can express "at most N plans", so this lock is the only thing
      // serializing two concurrent creates against one quota.
      await tx.$executeRaw`SELECT id FROM "ParkingOperator" WHERE id = ${operatorId} FOR UPDATE`

      await this.entitlements.assertCanCreateTariffPlan(operatorId, tx)

      // An operator's very first active plan needs no manual "make it default" step — with
      // nothing else to route to, an eligible (all-vehicle-types) plan should just work.
      // Once they have any active plan already, later creates go back to requiring an
      // explicit ask. A deleted plan must not block auto-default for its replacement:
      // deletePlan archives rather than removing the row, and archived rows are excluded
      // by the default lifecycle filter this count runs under (isActive stays true on
      // them by design, so the flag alone would not exclude them).
      const existingCount = await tx.tariffPlan.count({ where: { operatorId, isActive: true } })
      const isDefault = draft.isDefault || (existingCount === 0 && canBeDefault(vehicleTypes))

      // Creation can only add or replace a default, never remove the operator's last one,
      // so no replacement guard is needed here: swap the flag off any current default.
      if (isDefault) {
        await tx.tariffPlan.updateMany({
          where: { operatorId, isDefault: true },
          data: { isDefault: false },
        })
      }

      const plan = await tx.tariffPlan.create({
        data: {
          operatorId,
          name: draft.name,
          isActive: draft.isActive,
          isDefault,
          validFrom: draft.validFrom ? new Date(draft.validFrom) : null,
          validTo: draft.validTo ? new Date(draft.validTo) : null,
          timezone: draft.timezone,
          graceMinutes: draft.graceMinutes,
          incrementMinutes: draft.incrementMinutes,
          vehicleTypes,
          version: 1,
        },
      })

      await this.writeSchedule(tx, plan.id, draft)

      // Below platform admin, visibility now requires a management assignment — without
      // this the creator could not open or edit the plan they just wrote. Same transaction
      // as the insert.
      const managerIds = await initialManagerIds(tx, operatorId, {
        id: user.id,
        isPlatformAdmin: scope.kind === 'platform',
      })
      if (managerIds.length > 0) {
        await tx.tariffPlanManager.createMany({
          data: managerIds.map((userId) => ({
            tariffPlanId: plan.id,
            userId,
            assignedBy: user.id,
          })),
        })
      }

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'tariff_plan.created',
          entityType: 'TariffPlan',
          entityId: plan.id,
        },
      })

      return tx.tariffPlan.findFirstOrThrow({ where: { id: plan.id }, include: scheduleInclude })
    })

    // After the commit and outside the lock, for the same reason FacilitiesService.create
    // calls it there. Never throws — see QuotaThresholdService.
    await this.quotaThresholds.checkOperatorQuotaThresholds(operatorId)

    return this.toPlanDetail(created)
  }

  async updatePlan(
    user: AuthUser,
    planId: string,
    draft: TariffDraftDto,
    newDefaultPlanId?: string,
  ): Promise<TariffPlanDetail> {
    const scope = await this.assertPlanOwned(user, planId)
    this.validateDraft(draft)

    const draftVehicleTypes = draft.vehicleTypes.map((v) => VEHICLE_TO_PRISMA[v])

    // A default plan must always price every vehicle type; leaving it default with a
    // restricted vehicleTypes list is an invalid combination, not a swap situation.
    if (draft.isDefault && !canBeDefault(draftVehicleTypes)) {
      throw new DomainError(
        'A default plan must price every vehicle type (leave vehicleTypes empty).',
      )
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.tariffPlan.findFirst({
        where: { id: planId },
        select: {
          id: true,
          version: true,
          operatorId: true,
          isActive: true,
          isDefault: true,
          vehicleTypes: true,
        },
      })
      if (!existing) throw new TariffPlanNotFoundError(planId)

      // Only protect when this plan is currently the operator's active default AND the
      // draft removes that status — either by unsetting isDefault (plan stays active) or
      // by deactivating the plan (regardless of the draft's isDefault flag).
      if (existing.isDefault && existing.isActive) {
        const willUnsetDefault = !draft.isDefault
        const willDeactivate = !draft.isActive
        if (willDeactivate) {
          await this.guardDefaultRemoval(
            tx,
            user,
            scope,
            existing.operatorId,
            planId,
            false,
            newDefaultPlanId,
          )
        } else if (willUnsetDefault) {
          await this.guardDefaultRemoval(
            tx,
            user,
            scope,
            existing.operatorId,
            planId,
            true,
            newDefaultPlanId,
          )
        }
      } else if (draft.isDefault) {
        // Promoting this plan to default (it wasn't one before) — clear whichever other
        // plan currently holds it first, same as createPlan, so this never collides with
        // the one-active-default-per-operator partial unique index.
        await tx.tariffPlan.updateMany({
          where: { operatorId: existing.operatorId, isDefault: true, id: { not: planId } },
          data: { isDefault: false },
        })
      }

      // Rates cascade from tiers/windows; deleting both clears every rate row, then the
      // schedule is rebuilt from the draft. version bumps so in-flight quotes pinned to
      // the prior version keep their old price.
      await tx.rateCap.deleteMany({ where: { planId } })
      await tx.rateTier.deleteMany({ where: { planId } })
      await tx.rateWindow.deleteMany({ where: { planId } })

      await tx.tariffPlan.update({
        where: { id: planId },
        data: {
          name: draft.name,
          isActive: draft.isActive,
          isDefault: draft.isDefault,
          validFrom: draft.validFrom ? new Date(draft.validFrom) : null,
          validTo: draft.validTo ? new Date(draft.validTo) : null,
          timezone: draft.timezone,
          graceMinutes: draft.graceMinutes,
          incrementMinutes: draft.incrementMinutes,
          vehicleTypes: draftVehicleTypes,
          version: existing.version + 1,
        },
      })

      await this.writeSchedule(tx, planId, draft)

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'tariff_plan.updated',
          entityType: 'TariffPlan',
          entityId: planId,
        },
      })

      return tx.tariffPlan.findFirstOrThrow({ where: { id: planId }, include: scheduleInclude })
    })

    return this.toPlanDetail(updated)
  }

  /**
   * Deletes a plan: unassigns it from every facility currently pointing at it, then
   * ARCHIVES it. Archiving is what removes the plan from the operator's own view (the
   * lifecycle client extension default-filters to ACTIVE) while leaving it restorable
   * from the platform administrator's trash; it used to be a bare `isActive = false`,
   * which left the "deleted" plan listed and editable by the operator that deleted it.
   * Deleting a still-assigned plan is allowed and always unassigns — the frontend gates
   * this behind a confirm modal (see getAssignments).
   *
   * `isActive`/`isDefault` are deliberately NOT touched, here or in LifecycleService:
   * restoreTariffPlan re-validates the one-active-default rule against exactly those two
   * fields, and the partial unique index behind it counts only lifecycle-ACTIVE rows.
   * Writing isActive=false would make a later restore bring the plan back disabled and
   * skip the conflict check that protects the operator's default slot.
   *
   * All three steps share one transaction — the archive is handed this one rather than
   * opening its own — because a commit that unassigned every facility without archiving
   * would silently reprice them onto the operator default while the plan they pointed at
   * was still listed. Within it the order is fixed: guardDefaultRemoval writes the plan
   * row through the lifecycle-filtered client, which cannot see an archived row, so it
   * runs before the archive, never after.
   */
  async deletePlan(user: AuthUser, planId: string, newDefaultPlanId?: string): Promise<void> {
    const scope = await this.assertPlanOwned(user, planId)

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.tariffPlan.findFirst({
        where: { id: planId },
        select: { id: true, operatorId: true, isActive: true, isDefault: true },
      })
      if (!existing) throw new TariffPlanNotFoundError(planId)

      // Deletion always removes the plan from the active set, so if it was the operator's
      // active default a replacement must be promoted once other active plans remain.
      if (existing.isDefault && existing.isActive) {
        await this.guardDefaultRemoval(
          tx,
          user,
          scope,
          existing.operatorId,
          planId,
          false,
          newDefaultPlanId,
        )
      }

      await tx.facilityTariffAssignment.deleteMany({ where: { tariffPlanId: planId } })

      await this.lifecycle.archiveTariffPlan(
        { id: user.id, role: user.role },
        planId,
        'Deleted by operator',
        tx,
      )
    })
  }

  /**
   * Which facilities this plan prices. Every facility term is narrowed by
   * `facilityScopeWhere` and not merely by the plan's operator: this is a facility LISTING,
   * and reaching it through the plan side must not name — or count — a facility the caller
   * could not open directly. The consequence is that both numbers describe the caller's own
   * scope rather than the whole tenant, which is the only reading consistent with every
   * other surface they can see.
   */
  async getAssignments(user: AuthUser, planId: string): Promise<PlanAssignments> {
    const scope = await this.assertPlanOwned(user, planId)
    const facilityWhere = this.operatorScope.facilityScopeWhere(scope, user)

    const plan = await this.prisma.tariffPlan.findFirstOrThrow({
      where: { id: planId },
      select: { operatorId: true, isDefault: true },
    })

    // A plan can back several rows on the same facility (one per vehicle type), so dedupe
    // by facilityId — this summary counts distinct facilities with an explicit row, not rows.
    const rows = await this.prisma.facilityTariffAssignment.findMany({
      where: { tariffPlanId: planId, facility: facilityWhere },
      select: { facility: { select: { id: true, name: true } } },
    })

    const byId = new Map<string, { id: string; name: string }>()
    for (const row of rows) {
      byId.set(row.facility.id, row.facility)
    }
    const facilities = Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))

    // Implicit usage only matters for the operator's default plan: every facility that
    // lacks an explicit row for at least one vehicle type falls back to it. Skip the
    // extra queries for non-default plans (this endpoint is hit often).
    let implicitFacilityCount = 0
    if (plan.isDefault) {
      // AND rather than a spread: facilityWhere carries its own `operatorId`, undefined for
      // a platform caller, which would otherwise wipe the plan's operator out of the filter.
      const operatorFacilities: Prisma.FacilityWhereInput = {
        AND: [{ operatorId: plan.operatorId }, facilityWhere],
      }

      const facilityCounts = await this.prisma.facilityTariffAssignment.groupBy({
        by: ['facilityId'],
        where: { facility: operatorFacilities },
        _count: { vehicleType: true },
      })
      const fullyCoveredIds = new Set(
        facilityCounts.filter((f) => f._count.vehicleType >= 4).map((f) => f.facilityId),
      )
      const visibleFacilities = await this.prisma.facility.count({ where: operatorFacilities })
      implicitFacilityCount = visibleFacilities - fullyCoveredIds.size
    }

    return {
      facilities,
      count: facilities.length,
      isDefault: plan.isDefault,
      implicitFacilityCount,
    }
  }

  async simulate(user: AuthUser, input: SimulateDto): Promise<SimulateResult> {
    // Nothing persisted is touched; keep a scope resolution for role/tenancy consistency.
    //
    // Deliberately NOT narrowed by management assignment. The input is a free-standing
    // draft with no plan id — it is what the editor calls while a plan is being written,
    // including a brand new one that exists nowhere yet. There is no stored row to check a
    // manager against, and refusing the caller instead would make it impossible to price a
    // plan before creating it. Nothing about a submitted draft is readable back out.
    await this.operatorScope.resolve(user)

    const { draft, startsAt, endsAt } = input

    try {
      if (endsAt <= startsAt) throw new InvalidTariffScheduleError('endsAt must be after startsAt')

      validateSchedule({
        tiers: draft.tiers.map((t) => ({
          id: t.key,
          fromMinute: t.fromMinute,
          toMinute: t.toMinute,
          unit: UNIT_TO_PRISMA[t.unit],
          blockMinutes: t.blockMinutes,
        })),
        windows: draft.windows.map((w) => ({
          id: w.key,
          label: w.label,
          dayMask: w.dayMask,
          startMinute: w.startMinute,
          endMinute: w.endMinute,
        })),
        caps: draft.caps.map((c) => ({
          windowMinutes: c.windowMinutes,
          capCents: c.capCents,
          scope: SCOPE_TO_PRISMA[c.scope],
        })),
      })

      validateRateGrid(
        draft.tiers.map((t) => ({ id: t.key })),
        draft.windows.map((w) => ({ id: w.key, label: w.label })),
        draft.rates.map((r) => ({ tierId: r.tierKey, windowId: r.windowKey })),
      )

      const compiled = compileDraft({
        timezone: draft.timezone,
        graceMinutes: draft.graceMinutes,
        incrementMinutes: draft.incrementMinutes,
        tiers: draft.tiers.map((t) => ({
          key: t.key,
          fromMinute: t.fromMinute,
          toMinute: t.toMinute,
          unit: UNIT_TO_PRISMA[t.unit],
          blockMinutes: t.blockMinutes,
        })),
        windows: draft.windows.map((w) => ({
          key: w.key,
          label: w.label,
          dayMask: w.dayMask,
          startMinute: w.startMinute,
          endMinute: w.endMinute,
        })),
        rates: draft.rates.map((r) => ({
          tierKey: r.tierKey,
          windowKey: r.windowKey,
          priceCents: r.priceCents,
          currency: r.currency,
        })),
        caps: draft.caps.map((c) => ({
          windowMinutes: c.windowMinutes,
          capCents: c.capCents,
          scope: SCOPE_TO_PRISMA[c.scope],
        })),
      })

      // An operator previewing their own draft schedule. Neither the platform's take nor any
      // rider's perk belongs in a number whose whole purpose is "what does this plan charge".
      const result = priceStay(startsAt, endsAt, compiled, 0, null)
      const durationMinutes = Math.ceil((endsAt.getTime() - startsAt.getTime()) / 60_000)

      return {
        ok: true,
        quote: {
          durationMinutes,
          billableMinutes: result.billableMinutes,
          lineItems: result.lineItems,
          totalCents: result.totalCents,
          currency: compiled.currency,
        },
      }
    } catch (error) {
      if (error instanceof InvalidTariffScheduleError || error instanceof NoApplicableTariffError) {
        return { ok: false, error: error.message }
      }
      throw error
    }
  }

  /**
   * Enforces the "at least one active default once 2+ active plans remain" invariant when
   * a plan is losing its active-default status (either unset while staying active, or
   * deactivated/deleted). `planStaysActive` decides whether the plan itself still counts
   * toward the remaining active set:
   *  - unset-default-but-stays-active → true  (it remains active, just no longer default)
   *  - deactivate/delete              → false (it leaves the active set entirely)
   * With ≤1 active plan remaining the invariant is exempt (0 or 1 active plans need no
   * default). Otherwise a valid, catch-all `newDefaultPlanId` must be promoted; the
   * partial unique index is the concurrency guard — a concurrent promotion loses with a
   * P2002 which we translate to DefaultTariffRequiredError.
   *
   * Two different scopes on purpose. The remaining-active COUNT is operator-wide, because
   * the invariant it protects is: whether the tenant is left without a default has nothing
   * to do with who manages what. The CANDIDATE, by contrast, is a caller-supplied id
   * addressing one specific plan, and promoting it rewrites the fallback price of every
   * facility in the operator — so it is narrowed like any other plan the caller names, and
   * a plan they do not manage answers not-found rather than being quietly promoted.
   */
  private async guardDefaultRemoval(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    scope: OperatorScope,
    operatorId: string,
    planId: string,
    planStaysActive: boolean,
    newDefaultPlanId: string | undefined,
  ): Promise<void> {
    const remainingActive = await tx.tariffPlan.count({
      where: { operatorId, isActive: true, id: { not: planId } },
    })
    if ((planStaysActive ? remainingActive + 1 : remainingActive) <= 1) return

    if (!newDefaultPlanId) throw new DefaultTariffRequiredError()

    // AND rather than a spread: the managed predicate carries its own `operatorId` term,
    // which for a platform caller is `undefined` and would otherwise overwrite the explicit
    // one and let a candidate from a different operator through.
    const candidate = await tx.tariffPlan.findFirst({
      where: {
        AND: [
          { id: newDefaultPlanId, operatorId, isActive: true },
          this.operatorScope.tariffPlanScopeWhere(scope, user),
        ],
      },
      select: { vehicleTypes: true },
    })
    if (!candidate) throw new TariffPlanNotFoundError(newDefaultPlanId)
    if (!canBeDefault(candidate.vehicleTypes)) {
      throw new DomainError(
        'Candidate plan cannot price all vehicle types, so it cannot become the default.',
      )
    }

    // Clear this plan's own default flag first — the caller's own update (later in the
    // same transaction) will set its final isDefault/isActive value, but the partial
    // unique index rejects the promotion below if this plan still holds isDefault:true
    // at that moment (two active defaults for the same operator, even momentarily).
    await tx.tariffPlan.update({ where: { id: planId }, data: { isDefault: false } })

    try {
      await tx.tariffPlan.update({ where: { id: newDefaultPlanId }, data: { isDefault: true } })
    } catch (error) {
      // A concurrent request already promoted a different default; the partial unique
      // index rejects this one. Surface as a conflict so the caller re-picks.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DefaultTariffRequiredError()
      }
      throw error
    }
  }

  /**
   * The gate behind plan detail, update, delete and assignments. "Owned" now means owned by
   * an operator in scope AND managed by the caller — a plan the caller's operator owns but
   * nobody assigned them answers not-found, exactly as a foreign plan does, so the two
   * cannot be told apart.
   *
   * Returns the resolved scope so callers that go on to narrow something else (a default
   * candidate, the facilities using the plan) do not resolve it a second time.
   */
  private async assertPlanOwned(user: AuthUser, planId: string): Promise<OperatorScope> {
    const scope = await this.operatorScope.resolve(user)
    const plan = await this.prisma.tariffPlan.findFirst({
      where: { id: planId, ...this.operatorScope.tariffPlanScopeWhere(scope, user) },
      select: { id: true },
    })
    if (!plan) throw new TariffPlanNotFoundError(planId)
    return scope
  }

  private validateDraft(draft: TariffDraftDto): void {
    validateSchedule({
      tiers: draft.tiers.map((t) => ({
        id: t.key,
        fromMinute: t.fromMinute,
        toMinute: t.toMinute,
        unit: UNIT_TO_PRISMA[t.unit],
        blockMinutes: t.blockMinutes,
      })),
      windows: draft.windows.map((w) => ({
        id: w.key,
        label: w.label,
        dayMask: w.dayMask,
        startMinute: w.startMinute,
        endMinute: w.endMinute,
      })),
      caps: draft.caps.map((c) => ({
        windowMinutes: c.windowMinutes,
        capCents: c.capCents,
        scope: SCOPE_TO_PRISMA[c.scope],
      })),
    })

    validateRateGrid(
      draft.tiers.map((t) => ({ id: t.key })),
      draft.windows.map((w) => ({ id: w.key, label: w.label })),
      draft.rates.map((r) => ({ tierId: r.tierKey, windowId: r.windowKey })),
    )
  }

  private async writeSchedule(
    tx: Prisma.TransactionClient,
    planId: string,
    draft: TariffDraftDto,
  ): Promise<void> {
    const tierIdByKey = new Map<string, string>()
    for (const tier of draft.tiers) {
      const created = await tx.rateTier.create({
        data: {
          planId,
          fromMinute: tier.fromMinute,
          toMinute: tier.toMinute,
          unit: UNIT_TO_PRISMA[tier.unit],
          blockMinutes: tier.blockMinutes,
        },
        select: { id: true },
      })
      tierIdByKey.set(tier.key, created.id)
    }

    const windowIdByKey = new Map<string, string>()
    for (const window of draft.windows) {
      const created = await tx.rateWindow.create({
        data: {
          planId,
          label: window.label,
          dayMask: window.dayMask,
          startMinute: window.startMinute,
          endMinute: window.endMinute,
        },
        select: { id: true },
      })
      windowIdByKey.set(window.key, created.id)
    }

    if (draft.rates.length > 0) {
      await tx.tariffRate.createMany({
        data: draft.rates.map((rate) => ({
          tierId: tierIdByKey.get(rate.tierKey) as string,
          windowId: windowIdByKey.get(rate.windowKey) as string,
          priceCents: rate.priceCents,
          currency: rate.currency,
        })),
      })
    }

    if (draft.caps.length > 0) {
      await tx.rateCap.createMany({
        data: draft.caps.map((cap) => ({
          planId,
          windowMinutes: cap.windowMinutes,
          capCents: cap.capCents,
          scope: SCOPE_TO_PRISMA[cap.scope],
        })),
      })
    }
  }

  private toPlanDetail(plan: PlanWithSchedule): TariffPlanDetail {
    const rates = new Map<string, TariffRate>()
    for (const tier of plan.tiers) {
      for (const rate of tier.rates) {
        rates.set(`${rate.tierId}|${rate.windowId}`, rate)
      }
    }

    return {
      id: plan.id,
      name: plan.name,
      isActive: plan.isActive,
      isDefault: plan.isDefault,
      validFrom: plan.validFrom,
      validTo: plan.validTo,
      timezone: plan.timezone,
      graceMinutes: plan.graceMinutes,
      incrementMinutes: plan.incrementMinutes,
      vehicleTypes: plan.vehicleTypes.map((v) => VEHICLE_FROM_PRISMA[v]),
      version: plan.version,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      tiers: plan.tiers.map((t) => ({
        key: t.id,
        fromMinute: t.fromMinute,
        toMinute: t.toMinute,
        unit: UNIT_FROM_PRISMA[t.unit],
        blockMinutes: t.blockMinutes,
      })),
      windows: plan.windows.map((w) => ({
        key: w.id,
        label: w.label,
        dayMask: w.dayMask,
        startMinute: w.startMinute,
        endMinute: w.endMinute,
      })),
      rates: Array.from(rates.values()).map((r) => ({
        tierKey: r.tierId,
        windowKey: r.windowId,
        priceCents: r.priceCents,
        currency: r.currency,
      })),
      caps: plan.caps.map((c) => ({
        windowMinutes: c.windowMinutes,
        capCents: c.capCents,
        scope: SCOPE_FROM_PRISMA[c.scope],
      })),
    }
  }
}

function compilePlan(plan: PlanWithSchedule): CompiledPlan {
  const rates = new Map<string, TariffRate>()
  for (const tier of plan.tiers) {
    for (const rate of tier.rates) {
      rates.set(`${rate.tierId}|${rate.windowId}`, rate)
    }
  }

  const currency = plan.tiers[0]?.rates[0]?.currency ?? 'EUR'

  return {
    id: plan.id,
    version: plan.version,
    timezone: plan.timezone,
    graceMinutes: plan.graceMinutes,
    incrementMinutes: plan.incrementMinutes,
    currency,
    tiers: plan.tiers.map((t) => ({
      id: t.id,
      fromMinute: t.fromMinute,
      toMinute: t.toMinute,
      unit: t.unit,
      blockMinutes: t.blockMinutes,
    })),
    windows: plan.windows.map((w) => ({
      id: w.id,
      label: w.label,
      dayMask: w.dayMask,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
    })),
    caps: plan.caps.map((c) => ({
      windowMinutes: c.windowMinutes,
      capCents: c.capCents,
      scope: c.scope,
    })),
    price: (tierId, windowId) => rates.get(`${tierId}|${windowId}`)?.priceCents,
  }
}
