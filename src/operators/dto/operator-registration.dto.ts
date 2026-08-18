import { z } from 'zod'

export const registerOperatorSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  // Bounds match signInSchema rather than something stricter: this is the credential the
  // account will authenticate with, and a rule enforced here but not at sign-in would lock
  // someone out of an account they just created.
  password: z.string().min(8).max(200),
  businessName: z.string().trim().min(2).max(200),
  displayName: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).max(120).optional(),
  ),
})

export type RegisterOperatorDto = z.infer<typeof registerOperatorSchema>
