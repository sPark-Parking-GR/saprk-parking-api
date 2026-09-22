import { z } from 'zod'
import { PASSWORD_MAX, PASSWORD_MIN } from '@spark/types'

export const createAdminInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  displayName: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).max(120).optional(),
  ),
})

export type CreateAdminInviteDto = z.infer<typeof createAdminInviteSchema>

/**
 * The shared policy, like every other credential-setting endpoint. This used to allow 200
 * on the reasoning that it "matched the sign-in policy" — sign-in has no maximum at all, so
 * the bound matched nothing and left a platform admin able to create a password that
 * `resetPasswordSchema` would then refuse to let them change.
 */
export const acceptAdminInviteSchema = z.object({
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
})

export type AcceptAdminInviteDto = z.infer<typeof acceptAdminInviteSchema>
