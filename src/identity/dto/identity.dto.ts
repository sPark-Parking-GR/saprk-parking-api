import { LifecycleStatus, UserRole } from '@prisma/client'
import { z } from 'zod'

export const listUsersSchema = z.object({
  /** Free text over email and display name. */
  q: z.string().trim().max(200).optional(),
  role: z.nativeEnum(UserRole).optional(),
  lifecycleStatus: z.nativeEnum(LifecycleStatus).optional(),
  operatorId: z.string().trim().min(1).max(64).optional(),
  skip: z.coerce.number().int().nonnegative().max(10_000).default(0),
  take: z.coerce.number().int().positive().max(100).default(20),
})

export type ListUsersDto = z.infer<typeof listUsersSchema>

/**
 * Only the roles that are NOT derived from operator membership.
 *
 * OPERATOR_ADMIN and OPERATOR_STAFF are computed from OperatorMembership rows by
 * reconcileUserRole, so setting either here would be silently overwritten the next time a
 * membership changed. What this endpoint actually grants and revokes is PLATFORM authority;
 * operator authority is granted by adding someone to an operator.
 */
export const ASSIGNABLE_ROLES = [
  UserRole.USER,
  UserRole.PLATFORM_ADMIN,
  UserRole.SUPER_ADMIN,
] as const

// Mandatory: an audit trail of who gained platform authority without a stated motive
// records that it happened, not why.
const requiredReason = z.string().trim().min(3).max(500)

export const assignRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
  reason: requiredReason,
})

export type AssignRoleDto = z.infer<typeof assignRoleSchema>

export const reasonRequiredSchema = z.object({ reason: requiredReason })

export type ReasonRequiredDto = z.infer<typeof reasonRequiredSchema>
