import { CapScope, RateUnit, VehicleType } from '@prisma/client'
import { DateTime } from 'luxon'
import { z } from 'zod'

const lowercaseVehicle = z.enum(['car', 'motorcycle', 'van', 'truck'])
const lowercaseUnit = z.enum(['per_minute', 'per_block', 'flat'])
const lowercaseScope = z.enum(['stay', 'rolling'])

export type LowercaseVehicle = z.infer<typeof lowercaseVehicle>
export type LowercaseUnit = z.infer<typeof lowercaseUnit>
export type LowercaseScope = z.infer<typeof lowercaseScope>

export const VEHICLE_TO_PRISMA: Record<LowercaseVehicle, VehicleType> = {
  car: VehicleType.CAR,
  motorcycle: VehicleType.MOTORCYCLE,
  van: VehicleType.VAN,
  truck: VehicleType.TRUCK,
}

export const VEHICLE_FROM_PRISMA: Record<VehicleType, LowercaseVehicle> = {
  [VehicleType.CAR]: 'car',
  [VehicleType.MOTORCYCLE]: 'motorcycle',
  [VehicleType.VAN]: 'van',
  [VehicleType.TRUCK]: 'truck',
}

export const UNIT_TO_PRISMA: Record<LowercaseUnit, RateUnit> = {
  per_minute: RateUnit.PER_MINUTE,
  per_block: RateUnit.PER_BLOCK,
  flat: RateUnit.FLAT,
}

export const UNIT_FROM_PRISMA: Record<RateUnit, LowercaseUnit> = {
  [RateUnit.PER_MINUTE]: 'per_minute',
  [RateUnit.PER_BLOCK]: 'per_block',
  [RateUnit.FLAT]: 'flat',
}

export const SCOPE_TO_PRISMA: Record<LowercaseScope, CapScope> = {
  stay: CapScope.STAY,
  rolling: CapScope.ROLLING,
}

export const SCOPE_FROM_PRISMA: Record<CapScope, LowercaseScope> = {
  [CapScope.STAY]: 'stay',
  [CapScope.ROLLING]: 'rolling',
}

const MAX_PRICE_CENTS = 10_000_00

const draftTierSchema = z.object({
  key: z.string().min(1),
  fromMinute: z.number().int().min(0),
  toMinute: z.number().int().positive().nullable(),
  unit: lowercaseUnit,
  blockMinutes: z.number().int().positive().nullable(),
})

const draftWindowSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1).max(60),
  dayMask: z.number().int().min(0).max(127),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1440),
})

const draftRateSchema = z.object({
  tierKey: z.string(),
  windowKey: z.string(),
  priceCents: z.number().int().min(0).max(MAX_PRICE_CENTS),
  currency: z.string().length(3),
})

const draftCapSchema = z.object({
  windowMinutes: z.number().int().positive(),
  capCents: z.number().int().positive(),
  scope: lowercaseScope,
})

export const tariffDraftSchema = z
  .object({
    name: z.string().min(1).max(200),
    // Only honored for platform-admin callers; operator callers infer it from scope.
    operatorId: z.string().min(1).optional(),
    isActive: z.boolean(),
    isDefault: z.boolean().default(false),
    validFrom: z.string().datetime().nullable(),
    validTo: z.string().datetime().nullable(),
    timezone: z.string().min(1).max(64),
    graceMinutes: z.number().int().min(0).max(1440),
    incrementMinutes: z.number().int().min(1).max(1440),
    vehicleTypes: z.array(lowercaseVehicle),
    tiers: z.array(draftTierSchema).min(1),
    windows: z.array(draftWindowSchema).min(1),
    rates: z.array(draftRateSchema),
    caps: z.array(draftCapSchema),
  })
  .superRefine((data, ctx) => {
    if (data.validFrom && data.validTo && new Date(data.validFrom) >= new Date(data.validTo)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'validFrom must be before validTo',
        path: ['validFrom'],
      })
    }

    // An invalid IANA zone makes luxon produce NaN wall-clock minutes, yielding a plan
    // that can never price. Reject at write time so it can't be persisted.
    if (!DateTime.local().setZone(data.timezone).isValid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'invalid IANA timezone',
        path: ['timezone'],
      })
    }

    const tierKeys = new Set<string>()
    for (const tier of data.tiers) {
      if (tierKeys.has(tier.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate tier key ${tier.key}`, path: ['tiers'] })
      }
      tierKeys.add(tier.key)
    }

    const windowKeys = new Set<string>()
    for (const window of data.windows) {
      if (windowKeys.has(window.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate window key ${window.key}`, path: ['windows'] })
      }
      windowKeys.add(window.key)
    }

    const rateCells = new Set<string>()
    for (const rate of data.rates) {
      if (!tierKeys.has(rate.tierKey)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `rate references unknown tier ${rate.tierKey}`, path: ['rates'] })
      }
      if (!windowKeys.has(rate.windowKey)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `rate references unknown window ${rate.windowKey}`, path: ['rates'] })
      }
      const cell = `${rate.tierKey}|${rate.windowKey}`
      if (rateCells.has(cell)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate rate for ${cell}`, path: ['rates'] })
      }
      rateCells.add(cell)
    }
  })

export type TariffDraftDto = z.infer<typeof tariffDraftSchema>

export const simulateSchema = z.object({
  draft: tariffDraftSchema,
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  vehicleType: lowercaseVehicle,
})

export type SimulateDto = z.infer<typeof simulateSchema>

export const planParamSchema = z.object({
  planId: z.string().min(1),
})

export type PlanParam = z.infer<typeof planParamSchema>
