import { BillingInterval, SubscriptionStatus } from '@prisma/client'
import { z } from 'zod'
import { entitlementOverrideSchema, entitlementsSchema } from '../entitlements.schema'

// Stable, lowercase, machine-readable. It is the identifier DEFAULT_PLAN_CODE resolves and
// the one any future provider mapping will key on, so it is immutable after creation —
// there is no `code` on the update schema. Exported because the driver catalog identifies
// its plans by exactly the same rule, and two copies would drift.
export const planCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(50)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'code must be lowercase alphanumeric with - or _')

// ISO 4217. Money is integer minor units everywhere in this codebase; there is no decimal
// price field to get wrong.
export const currencySchema = z
  .string()
  .trim()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 alphabetic code')

export const createPlanSchema = z
  .object({
    code: planCodeSchema,
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).optional(),
    priceCents: z.number().int().min(0).max(100_000_000),
    currency: currencySchema.default('EUR'),
    interval: z.nativeEnum(BillingInterval).default(BillingInterval.MONTHLY),
    entitlements: entitlementsSchema,
    isPublic: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .strict()

export type CreatePlanDto = z.infer<typeof createPlanSchema>

export const updatePlanSchema = createPlanSchema.omit({ code: true }).partial().strict()

export type UpdatePlanDto = z.infer<typeof updatePlanSchema>

export const listPlansSchema = z
  .object({
    includeArchived: z.coerce.boolean().default(false),
  })
  .strict()

export type ListPlansDto = z.infer<typeof listPlansSchema>

export const archivePlanSchema = z
  .object({ reason: z.string().trim().min(3).max(500).optional() })
  .strict()

export type ArchivePlanDto = z.infer<typeof archivePlanSchema>

/**
 * Assign or change an operator's subscription. `planId` is required even when only the
 * status is moving: an assignment that does not say which plan it is asserting is how two
 * administrators end up disagreeing about what a tenant bought.
 */
export const assignSubscriptionSchema = z
  .object({
    planId: z.string().trim().min(1),
    status: z.nativeEnum(SubscriptionStatus).default(SubscriptionStatus.ACTIVE),
    currentPeriodEnd: z.coerce.date().optional(),
    trialEndsAt: z.coerce.date().optional(),
    cancelAtPeriodEnd: z.boolean().default(false),
    // Null clears a previously negotiated deviation; omitted leaves it untouched, so a
    // plan change does not silently drop a deal nobody meant to revoke.
    entitlementOverride: entitlementOverrideSchema.strict().nullable().optional(),
  })
  .strict()

export type AssignSubscriptionDto = z.infer<typeof assignSubscriptionSchema>

export const setOverrideSchema = z
  .object({ entitlementOverride: entitlementOverrideSchema.strict().nullable() })
  .strict()

export type SetOverrideDto = z.infer<typeof setOverrideSchema>
