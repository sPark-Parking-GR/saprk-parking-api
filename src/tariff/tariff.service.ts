import { Injectable } from '@nestjs/common'
import type {
  Prisma,
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
  InvalidTariffScheduleError,
  NoApplicableTariffError,
  FacilityNotFoundError,
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
    })

    if (!facility) throw new FacilityNotFoundError(facilityId)

    const plan = await this.resolveActivePlan(facilityId, startsAt, vehicleType)
    if (!plan) throw new NoApplicableTariffError(facilityId)

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
   * Quote totals for many facilities in a single tariff-plan query; pricing runs in
   * memory. Mirrors computeQuote's plan selection, but skips the per-facility existence
   * check (search already filters to active facilities). Facilities whose plan has no
   * applicable price are omitted (caller treats as no price).
   */
  async computeTotalsByFacility(
    facilityIds: string[],
    startsAt: Date,
    endsAt: Date,
    vehicleType: VehicleType,
  ): Promise<Map<string, number>> {
    if (facilityIds.length === 0 || endsAt <= startsAt) return new Map()

    const plans = await this.prisma.tariffPlan.findMany({
      where: {
        facilityId: { in: facilityIds },
        isActive: true,
        OR: [{ validFrom: null }, { validFrom: { lte: startsAt } }],
        AND: [
          { OR: [{ validTo: null }, { validTo: { gte: startsAt } }] },
          { OR: [{ vehicleTypes: { isEmpty: true } }, { vehicleTypes: { has: vehicleType } }] },
        ],
      },
      include: scheduleInclude,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })

    const totals = new Map<string, number>()
    for (const plan of plans) {
      // Query order matches resolveActivePlan within each facility, so the first plan
      // seen per facility is its active plan.
      if (totals.has(plan.facilityId)) continue
      try {
        const result = priceStay(startsAt, endsAt, compilePlan(plan))
        totals.set(plan.facilityId, result.totalCents)
      } catch {
        // Incomplete/invalid schedule: omit this facility from priced results.
      }
    }
    return totals
  }

  private async resolveActivePlan(
    facilityId: string,
    atTime: Date,
    vehicleType: VehicleType,
  ): Promise<PlanWithSchedule | null> {
    const plans = await this.prisma.tariffPlan.findMany({
      where: {
        facilityId,
        isActive: true,
        OR: [{ validFrom: null }, { validFrom: { lte: atTime } }],
        AND: [
          { OR: [{ validTo: null }, { validTo: { gte: atTime } }] },
          { OR: [{ vehicleTypes: { isEmpty: true } }, { vehicleTypes: { has: vehicleType } }] },
        ],
      },
      include: scheduleInclude,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })

    return plans[0] ?? null
  }

  async listPlans(user: AuthUser, facilityId: string): Promise<{ items: TariffPlanListItem[] }> {
    await this.assertFacilityOwned(user, facilityId)

    const plans = await this.prisma.tariffPlan.findMany({
      where: { facilityId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        isDefault: true,
        isActive: true,
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
      isDefault: p.isDefault,
      isActive: p.isActive,
      validFrom: p.validFrom,
      validTo: p.validTo,
      vehicleTypes: p.vehicleTypes.map((v) => VEHICLE_FROM_PRISMA[v]),
      version: p.version,
      updatedAt: p.updatedAt,
    }))

    return { items }
  }

  async getPlanDetail(
    user: AuthUser,
    facilityId: string,
    planId: string,
  ): Promise<TariffPlanDetail> {
    await this.assertFacilityOwned(user, facilityId)

    const plan = await this.prisma.tariffPlan.findFirst({
      where: { id: planId, facilityId },
      include: scheduleInclude,
    })
    if (!plan) throw new FacilityNotFoundError(facilityId)

    return this.toPlanDetail(plan)
  }

  async createPlan(
    user: AuthUser,
    facilityId: string,
    draft: TariffDraftDto,
  ): Promise<TariffPlanDetail> {
    await this.assertFacilityOwned(user, facilityId)
    this.validateDraft(draft)

    const created = await this.prisma.$transaction(async (tx) => {
      if (draft.isDefault) {
        await tx.tariffPlan.updateMany({
          where: { facilityId, isDefault: true },
          data: { isDefault: false },
        })
      }

      const plan = await tx.tariffPlan.create({
        data: {
          facilityId,
          name: draft.name,
          isDefault: draft.isDefault,
          isActive: draft.isActive,
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
    facilityId: string,
    planId: string,
    draft: TariffDraftDto,
  ): Promise<TariffPlanDetail> {
    await this.assertFacilityOwned(user, facilityId)
    this.validateDraft(draft)

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.tariffPlan.findFirst({
        where: { id: planId, facilityId },
        select: { id: true, version: true },
      })
      if (!existing) throw new FacilityNotFoundError(facilityId)

      if (draft.isDefault) {
        await tx.tariffPlan.updateMany({
          where: { facilityId, isDefault: true, id: { not: planId } },
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
          isDefault: draft.isDefault,
          isActive: draft.isActive,
          validFrom: draft.validFrom ? new Date(draft.validFrom) : null,
          validTo: draft.validTo ? new Date(draft.validTo) : null,
          timezone: draft.timezone,
          graceMinutes: draft.graceMinutes,
          incrementMinutes: draft.incrementMinutes,
          vehicleTypes: draft.vehicleTypes.map((v) => VEHICLE_TO_PRISMA[v]),
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

  async softDeletePlan(user: AuthUser, facilityId: string, planId: string): Promise<void> {
    await this.assertFacilityOwned(user, facilityId)

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.tariffPlan.findFirst({
        where: { id: planId, facilityId },
        select: { id: true },
      })
      if (!existing) throw new FacilityNotFoundError(facilityId)

      await tx.tariffPlan.update({ where: { id: planId }, data: { isActive: false } })

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'tariff_plan.deactivated',
          entityType: 'TariffPlan',
          entityId: planId,
        },
      })
    })
  }

  async simulate(user: AuthUser, facilityId: string, input: SimulateDto): Promise<SimulateResult> {
    await this.assertFacilityOwned(user, facilityId)

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

  private async assertFacilityOwned(user: AuthUser, facilityId: string): Promise<void> {
    const scope = await this.operatorScope.resolve(user)
    const facility = await this.prisma.facility.findFirst({
      where: { id: facilityId, ...this.operatorScope.scopeWhere(scope) },
      select: { id: true },
    })
    if (!facility) throw new FacilityNotFoundError(facilityId)
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
      isDefault: plan.isDefault,
      isActive: plan.isActive,
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
