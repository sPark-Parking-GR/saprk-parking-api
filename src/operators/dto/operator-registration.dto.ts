import { z } from 'zod'
import { PASSWORD_MAX, PASSWORD_MIN } from '@spark/types'

export const registerOperatorSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  // The shared policy. Previously 200 on the reasoning that it matched signInSchema, which
  // is min(1) with no maximum — so it matched nothing, and put the ceiling above what reset
  // would later accept.
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
  businessName: z.string().trim().min(2).max(200),
  displayName: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).max(120).optional(),
  ),
})

export type RegisterOperatorDto = z.infer<typeof registerOperatorSchema>
