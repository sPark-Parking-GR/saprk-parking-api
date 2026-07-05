import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type {
  RateCap,
  RateTier,
  RateWindow,
  TariffPlan,
  TariffRate,
  VehicleType,
} from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import {
  DefaultTariffRequiredError,
  DomainError,
  InvalidTariffScheduleError,
  NoApplicableTariffError,
  FacilityNotFoundError,
  TariffPlanNotFoundError,
} from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
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
  type SimulateDto,
  type TariffDraftDto,
} from './dto/tariff.dto'
import {
  QUOTE_TTL_MINUTES,
  type CompiledPlan,
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
 * vehicle class (empty vehicleTypes = all classes).
 */
export function isPlanApplicable(
  plan: TariffPlan,
  at: Date,
  vehicleType: VehicleType,
): boolean {
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
  ) {}

  async computeQuote(request: QuoteRequest): Promise<PriceQuote> {
    const { facilityId, startsAt, endsAt, vehicleType } = request

    if (endsAt <= startsAt) {
      throw new Error('endsAt must be after startsAt')
    }

    const facility = await this.prisma.facility.findFirst({
      where: { id: facilityId, isActive: true, isVerified: true },
      include: {
        tariffAssignments: {
          where: { vehicleType },
          include: { tariffPlan: { include: scheduleInclude } },
        },
      },
    })

    if (!facility) throw new FacilityNotFoundError(facilityId)

    let plan: PlanWithSchedule | null = facility.tariffAssignments[0]?.tariffPlan ?? null
    if (!plan) {
      plan = await this.prisma.tariffPlan.findFirst({
        where: { operatorId: facility.operatorId, isDefault: true, isActive: true },
        include: scheduleInclude,
      })
    }
    if (!plan || !isPlanApplicable(plan, startsAt, vehicleType)) {
      throw new NoApplicableTariffError(facilityId)
    }

    const compiled = compilePlan(plan)
    const result = priceStay(startsAt, endsAt, compiled)

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
      currency: compiled.currency,
      expiresAt,
      planId: compiled.id,
      planVersion: compiled.version,
    }
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

    const operatorIds = [...new Set(facilities.map((f) => f.operatorId))]
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
        defaultsByOperator.get(facility.operatorId) ??
        null
      if (!plan || !isPlanApplicable(plan, startsAt, vehicleType)) continue
      try {
        const result = priceStay(startsAt, endsAt, compilePlan(plan))
        totals.set(facility.id, result.totalCents)
      } catch {
        // Incomplete/invalid schedule: omit this facility from priced results.
      }
    }
    return totals
  }

  async listPlans(user: AuthUser): Promise<{ items: TariffPlanListItem[] }> {
    const scope = await this.operatorScope.resolve(user)

    const plans = await this.prisma.tariffPlan.findMany({
      where: { ...this.operatorScope.scopeWhere(scope) },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
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

    const operatorId = scope.kind === 'platform' ? draft.operatorId : scope.operatorId
    if (!operatorId) throw new DomainError('operatorId required')

    const operator = await this.prisma.parkingOperator.findUnique({
      where: { id: operatorId },
      select: { id: true },
    })
    if (!operator) throw new DomainError('operatorId required')

    if (draft.isDefault && !canBeDefault(draft.vehicleTypes.map((v) => VEHICLE_TO_PRISMA[v]))) {
      throw new DomainError('A default plan must price every vehicle type (leave vehicleTypes empty).')
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // Creation can only add or replace a default, never remove the operator's last one,
      // so no replacement guard is needed here: swap the flag off any current default.
      if (draft.isDefault) {
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
          isDefault: draft.isDefault,
          validFrom: draft.validFrom ? new Date(draft.validFrom) : null,
          validTo: draft.validTo ? new Date(draft.validTo) : null,
          timezone: draft.timezone,
          graceMinutes: draft.graceMinutes,
          incrementMinutes: draft.incrementMinutes,
          vehicleTypes: draft.vehicleTypes.map((v) => VEHICLE_TO_PRISMA[v]),
          version: 1,
        },
      })

      await this.writeSchedule(tx, plan.id, draft)

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

    return this.toPlanDetail(created)
  }

  async updatePlan(
    user: AuthUser,
    planId: string,
    draft: TariffDraftDto,
    newDefaultPlanId?: string,
  ): Promise<TariffPlanDetail> {
    await this.assertPlanOwned(user, planId)
    this.validateDraft(draft)

    const draftVehicleTypes = draft.vehicleTypes.map((v) => VEHICLE_TO_PRISMA[v])

    // A default plan must always price every vehicle type; leaving it default with a
    // restricted vehicleTypes list is an invalid combination, not a swap situation.
    if (draft.isDefault && !canBeDefault(draftVehicleTypes)) {
      throw new DomainError('A default plan must price every vehicle type (leave vehicleTypes empty).')
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
          await this.guardDefaultRemoval(tx, existing.operatorId, planId, false, newDefaultPlanId)
        } else if (willUnsetDefault) {
          await this.guardDefaultRemoval(tx, existing.operatorId, planId, true, newDefaultPlanId)
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
   * Soft-deletes a plan: unassigns it from every facility currently pointing at it and
   * deactivates it, atomically. Deactivating a still-assigned plan is allowed and always
   * unassigns — the frontend gates this behind a confirm modal (see getAssignments).
   */
  async deletePlan(user: AuthUser, planId: string, newDefaultPlanId?: string): Promise<void> {
    await this.assertPlanOwned(user, planId)

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.tariffPlan.findFirst({
        where: { id: planId },
        select: { id: true, operatorId: true, isActive: true, isDefault: true },
      })
      if (!existing) throw new TariffPlanNotFoundError(planId)

      // Deletion always removes the plan from the active set, so if it was the operator's
      // active default a replacement must be promoted once other active plans remain.
      if (existing.isDefault && existing.isActive) {
        await this.guardDefaultRemoval(tx, existing.operatorId, planId, false, newDefaultPlanId)
      }

      await tx.facilityTariffAssignment.deleteMany({ where: { tariffPlanId: planId } })

      await tx.tariffPlan.update({ where: { id: planId }, data: { isActive: false } })

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'tariff_plan.deleted',
          entityType: 'TariffPlan',
          entityId: planId,
        },
      })
    })
  }

  async getAssignments(user: AuthUser, planId: string): Promise<PlanAssignments> {
    await this.assertPlanOwned(user, planId)

    const plan = await this.prisma.tariffPlan.findFirstOrThrow({
      where: { id: planId },
      select: { operatorId: true, isDefault: true },
    })

    // A plan can back several rows on the same facility (one per vehicle type), so dedupe
    // by facilityId — this summary counts distinct facilities with an explicit row, not rows.
    const rows = await this.prisma.facilityTariffAssignment.findMany({
      where: { tariffPlanId: planId },
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
      const facilityCounts = await this.prisma.facilityTariffAssignment.groupBy({
        by: ['facilityId'],
        where: { facility: { operatorId: plan.operatorId } },
        _count: { vehicleType: true },
      })
      const fullyCoveredIds = new Set(
        facilityCounts.filter((f) => f._count.vehicleType >= 4).map((f) => f.facilityId),
      )
      const totalOperatorFacilities = await this.prisma.facility.count({
        where: { operatorId: plan.operatorId },
      })
      implicitFacilityCount = totalOperatorFacilities - fullyCoveredIds.size
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

      const result = priceStay(startsAt, endsAt, compiled)
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
      if (
        error instanceof InvalidTariffScheduleError ||
        error instanceof NoApplicableTariffError
      ) {
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
   */
  private async guardDefaultRemoval(
    tx: Prisma.TransactionClient,
    operatorId: string,
    planId: string,
    planStaysActive: boolean,
    newDefaultPlanId: string | undefined,
  ): Promise<void> {
    const others = await tx.tariffPlan.findMany({
      where: { operatorId, isActive: true, id: { not: planId } },
      select: { id: true, vehicleTypes: true },
    })
    const remainingActive = planStaysActive ? others.length + 1 : others.length
    if (remainingActive <= 1) return

    if (!newDefaultPlanId) throw new DefaultTariffRequiredError()

    const candidate = others.find((o) => o.id === newDefaultPlanId)
    if (!candidate) throw new TariffPlanNotFoundError(newDefaultPlanId)
    if (!canBeDefault(candidate.vehicleTypes)) {
      throw new DomainError('Candidate plan cannot price all vehicle types, so it cannot become the default.')
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

  private async assertPlanOwned(user: AuthUser, planId: string): Promise<void> {
    const scope = await this.operatorScope.resolve(user)
    const plan = await this.prisma.tariffPlan.findFirst({
      where: { id: planId, ...this.operatorScope.scopeWhere(scope) },
      select: { id: true },
    })
    if (!plan) throw new TariffPlanNotFoundError(planId)
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
