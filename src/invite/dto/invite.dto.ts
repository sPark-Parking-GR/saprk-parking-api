import { OperatorMemberRole } from '@prisma/client'
import { z } from 'zod'

export const createInviteSchema = z.object({
  email: z.string().email(),
})

export type CreateInviteDto = z.infer<typeof createInviteSchema>

export const createMemberInviteSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(OperatorMemberRole).default(OperatorMemberRole.STAFF),
  // Optional hint, never a grant: an operator caller with a single membership implies it,
  // one with several must name it, and either way the id is checked against the caller's
  // own memberships before anything is written. A platform admin must always name one.
  operatorId: z.string().min(1).optional(),
})

export type CreateMemberInviteDto = z.infer<typeof createMemberInviteSchema>

export const acceptInviteSchema = z.object({
  password: z.string().min(8).max(128),
  // Only the ONBOARDING flow needs this — a MEMBER invite attaches to an operator that
  // already has a name. Enforced as required for that kind in the service layer, where
  // the invite's kind is actually known.
  businessName: z.string().trim().min(1).max(200).optional(),
})

export type AcceptInviteDto = z.infer<typeof acceptInviteSchema>
