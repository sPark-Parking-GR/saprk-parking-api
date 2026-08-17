import { z } from 'zod'

export const createAdminInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  displayName: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).max(120).optional(),
  ),
})

export type CreateAdminInviteDto = z.infer<typeof createAdminInviteSchema>

/**
 * Bounds match the sign-in policy rather than a stricter one: the password set here is the
 * same credential the account will authenticate with, so a rule this endpoint enforces but
 * sign-in does not would lock someone out of an account they just created.
 */
export const acceptAdminInviteSchema = z.object({
  password: z.string().min(8).max(200),
})

export type AcceptAdminInviteDto = z.infer<typeof acceptAdminInviteSchema>
