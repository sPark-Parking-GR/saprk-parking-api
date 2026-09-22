import { BillingInterval, SubscriptionStatus } from '@prisma/client'
import { z } from 'zod'
import {
  driverEntitlementOverrideSchema,
  driverEntitlementsSchema,
} from '../driver-entitlements.schema'
import { currencySchema, planCodeSchema } from './subscriptions.dto'

export const createDriverPlanSchema = z
  .object({
    code: planCodeSchema,
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).optional(),
    priceCents: z.number().int().min(0).max(100_000_000),
    currency: currencySchema.default('EUR'),
    interval: z.nativeEnum(BillingInterval).default(BillingInterval.MONTHLY),
    entitlements: driverEntitlementsSchema,
    isPublic: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .strict()

export type CreateDriverPlanDto = z.infer<typeof createDriverPlanSchema>

export const updateDriverPlanSchema = createDriverPlanSchema.omit({ code: true }).partial().strict()

export type UpdateDriverPlanDto = z.infer<typeof updateDriverPlanSchema>

export const listDriverPlansSchema = z
  .object({
    includeArchived: z.coerce.boolean().default(false),
  })
  .strict()

export type ListDriverPlansDto = z.infer<typeof listDriverPlansSchema>

export const archiveDriverPlanSchema = z
  .object({ reason: z.string().trim().min(3).max(500).optional() })
  .strict()

export type ArchiveDriverPlanDto = z.infer<typeof archiveDriverPlanSchema>

/**
 * Assign or change a rider's subscription. `planId` is required even when only the status
 * is moving: an assignment that does not say which plan it is asserting is how two
 * administrators end up disagreeing about what a rider bought.
 */
export const assignDriverSubscriptionSchema = z
  .object({
    planId: z.string().trim().min(1),
    status: z.nativeEnum(SubscriptionStatus).default(SubscriptionStatus.ACTIVE),
    currentPeriodEnd: z.coerce.date().optional(),
    trialEndsAt: z.coerce.date().optional(),
    cancelAtPeriodEnd: z.boolean().default(false),
    // Null clears a previously negotiated deviation; omitted leaves it untouched, so a
    // plan change does not silently drop a deal nobody meant to revoke.
    entitlementOverride: driverEntitlementOverrideSchema.strict().nullable().optional(),
  })
  .strict()

export type AssignDriverSubscriptionDto = z.infer<typeof assignDriverSubscriptionSchema>

export const setDriverOverrideSchema = z
  .object({ entitlementOverride: driverEntitlementOverrideSchema.strict().nullable() })
  .strict()

export type SetDriverOverrideDto = z.infer<typeof setDriverOverrideSchema>
