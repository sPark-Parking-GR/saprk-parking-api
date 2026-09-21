import { z } from 'zod'
import { PASSWORD_MAX, PASSWORD_MIN } from '@spark/types'

// No `role` field, by design. Public sign-up is the consumer registration path and must
// stay open, so anything it accepts is attacker-controlled — a role here was a
// self-service privilege escalation. Elevated roles come only from the invite flow.
export const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
  displayName: z.string().min(1).max(80).optional(),
})

export type SignUpDto = z.infer<typeof signUpSchema>

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export type SignInDto = z.infer<typeof signInSchema>

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
})

export type RefreshDto = z.infer<typeof refreshSchema>

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
})

export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>

/**
 * The only way to change a display name after the account exists.
 *
 * Before this, `User.displayName` was written once at creation and never again — the sole
 * later writes were the anonymisation on delete and purge. An operator admin onboarded
 * before the accept form collected a personal name therefore carried their company name
 * as their own, in every list that names a human, permanently.
 *
 * Empty means "no name", not "unchanged": clearing it back to the email is a legitimate
 * thing to want, and there is no other field here to disambiguate against.
 */
export const updateProfileSchema = z.object({
  displayName: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.string().trim().min(1).max(120).nullable(),
  ),
})

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
})

export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>

// The bearer token proves the session; this proves the person holding the handset. An
// unlocked phone left on a table must not be enough to erase an account, and the app
// refreshes its token silently every 15 minutes, so token age proves nothing on its own.
// Bounds match signInSchema, not signUpSchema — an account hashed under an older policy
// must still be able to spell its own password.
export const deleteAccountSchema = z.object({
  password: z.string().min(1),
})

export type DeleteAccountDto = z.infer<typeof deleteAccountSchema>

// Step one of the change-password flow, and the only part of it that travels in a request
// body. The NEW password is never sent here — it is set later, on the emailed link, through
// resetPasswordSchema — so this carries exactly one thing: proof the caller knows the
// password they already have. Bounded like deleteAccountSchema rather than signUpSchema for
// the same reason: an account hashed under an older policy must still be able to spell its
// own password, and applying the new-password floor to an existing one would lock it out of
// the very flow that would fix it.
export const requestPasswordChangeSchema = z.object({
  currentPassword: z.string().min(1),
})

export type RequestPasswordChangeDto = z.infer<typeof requestPasswordChangeSchema>
