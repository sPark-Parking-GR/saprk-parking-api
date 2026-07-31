import { z } from 'zod'

// No `role` field, by design. Public sign-up is the consumer registration path and must
// stay open, so anything it accepts is attacker-controlled — a role here was a
// self-service privilege escalation. Elevated roles come only from the invite flow.
export const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
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

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(128),
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
