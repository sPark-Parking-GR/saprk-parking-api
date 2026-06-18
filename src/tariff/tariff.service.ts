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
import { NoApplicableTariffError, FacilityNotFoundError } from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
import { priceStay } from './pricing-engine'
import {
  QUOTE_TTL_MINUTES,
  type CompiledPlan,
  type PriceQuote,
  type QuoteRequest,
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
  constructor(private readonly prisma: PrismaService) {}

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
