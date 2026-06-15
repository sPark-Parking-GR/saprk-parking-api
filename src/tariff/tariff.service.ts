import { Injectable } from '@nestjs/common'
import { TariffType, type TariffPlan, type TariffRule, type VehicleType } from '@prisma/client'
import { NoApplicableTariffError, FacilityNotFoundError } from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
import {
  QUOTE_TTL_MINUTES,
  type PriceQuote,
  type QuoteLineItem,
  type QuoteRequest,
} from './tariff.types'

type PlanWithRules = TariffPlan & { rules: TariffRule[] }

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

    const plan = await this.resolveActivePlan(facilityId, startsAt)
    if (!plan) throw new NoApplicableTariffError(facilityId)

    const durationMinutes = Math.ceil((endsAt.getTime() - startsAt.getTime()) / 60_000)
    const lineItems = this.computeLineItems(plan.rules, vehicleType, durationMinutes, startsAt)

    const totalCents = lineItems.reduce((sum, item) => sum + item.subtotalCents, 0)
    const expiresAt = new Date(Date.now() + QUOTE_TTL_MINUTES * 60_000)

    return {
      facilityId,
      startsAt,
      endsAt,
      durationMinutes,
      vehicleType,
      lineItems,
      totalCents,
      currency: 'EUR',
      expiresAt,
    }
  }

  private async resolveActivePlan(
    facilityId: string,
    atTime: Date,
  ): Promise<PlanWithRules | null> {
    const plans = await this.prisma.tariffPlan.findMany({
      where: {
        facilityId,
        isActive: true,
        OR: [{ validFrom: null }, { validFrom: { lte: atTime } }],
        AND: [{ OR: [{ validTo: null }, { validTo: { gte: atTime } }] }],
      },
      include: { rules: { orderBy: { sortOrder: 'asc' } } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })

    return plans[0] ?? null
  }

  private computeLineItems(
    rules: TariffRule[],
    vehicleType: VehicleType,
    durationMinutes: number,
    startsAt: Date,
  ): QuoteLineItem[] {
    const applicable = rules.filter(
      (r) =>
        (r.vehicleTypes.length === 0 || r.vehicleTypes.includes(vehicleType)) &&
        (r.minDurationMinutes == null || durationMinutes >= r.minDurationMinutes) &&
        (r.maxDurationMinutes == null || durationMinutes <= r.maxDurationMinutes),
    )

    if (applicable.length === 0) return []

    const isOvernight = this.isOvernightWindow(startsAt, durationMinutes)

    const overnightRule = applicable.find((r) => r.type === TariffType.OVERNIGHT)
    const flatRule = applicable.find((r) => r.type === TariffType.FLAT)
    const dailyRule = applicable.find((r) => r.type === TariffType.DAILY)
    const hourlyRule = applicable.find((r) => r.type === TariffType.HOURLY)

    if (isOvernight && overnightRule) {
      return [
        {
          label: 'Overnight rate',
          durationMinutes,
          unitPriceCents: overnightRule.priceCents,
          quantity: 1,
          subtotalCents: overnightRule.priceCents,
        },
      ]
    }

    if (flatRule) {
      return [
        {
          label: 'Flat rate',
          durationMinutes,
          unitPriceCents: flatRule.priceCents,
          quantity: 1,
          subtotalCents: flatRule.priceCents,
        },
      ]
    }

    if (durationMinutes >= 60 * 24 && dailyRule) {
      const days = Math.ceil(durationMinutes / (60 * 24))
      return [
        {
          label: 'Daily rate',
          durationMinutes,
          unitPriceCents: dailyRule.priceCents,
          quantity: days,
          subtotalCents: dailyRule.priceCents * days,
        },
      ]
    }

    if (hourlyRule) {
      const hours = Math.ceil(durationMinutes / 60)
      return [
        {
          label: 'Hourly rate',
          durationMinutes,
          unitPriceCents: hourlyRule.priceCents,
          quantity: hours,
          subtotalCents: hourlyRule.priceCents * hours,
        },
      ]
    }

    return []
  }

  private isOvernightWindow(startsAt: Date, durationMinutes: number): boolean {
    const hour = startsAt.getHours()
    const endsNextDay = durationMinutes > 60 * 6
    return hour >= 20 && endsNextDay
  }
}
