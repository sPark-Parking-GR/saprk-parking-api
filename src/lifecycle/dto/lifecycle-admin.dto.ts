import { LifecycleStatus } from '@prisma/client'
import { z } from 'zod'
import { DESTRUCTIVE_ACTIONS, LIFECYCLE_RESOURCE_TYPES } from '../lifecycle.types'

/**
 * The only thing standing between a caller-supplied path segment and a model lookup. A
 * closed enum, so an unknown resourceType is a 400 at the boundary and never reaches
 * Prisma or SQL.
 */
export const resourceTypeSchema = z.enum(LIFECYCLE_RESOURCE_TYPES)

export const listTrashSchema = z.object({
  resourceType: resourceTypeSchema.optional(),
  status: z.nativeEnum(LifecycleStatus).optional(),
  skip: z.coerce.number().int().nonnegative().max(10_000).default(0),
  take: z.coerce.number().int().positive().max(100).default(20),
})

export type ListTrashDto = z.infer<typeof listTrashSchema>

// Defaults to the most destructive action, so a preview requested with no opinion shows
// the worst case rather than the mildest.
export const impactQuerySchema = z.object({
  action: z.enum(DESTRUCTIVE_ACTIONS).default('purge'),
})

export type ImpactQueryDto = z.infer<typeof impactQuerySchema>

// Mandatory wherever the action destroys something: an audit trail without a motive
// records that data vanished, not why.
const requiredReason = z.string().trim().min(3).max(500)

export const reasonRequiredSchema = z.object({ reason: requiredReason })

export const reasonOptionalSchema = z.object({
  reason: requiredReason.optional(),
})

export type ReasonRequiredDto = z.infer<typeof reasonRequiredSchema>
export type ReasonOptionalDto = z.infer<typeof reasonOptionalSchema>
