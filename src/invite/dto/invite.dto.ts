import { z } from 'zod'

export const createInviteSchema = z.object({
  email: z.string().email(),
  businessName: z.string().min(1).max(200),
})

export type CreateInviteDto = z.infer<typeof createInviteSchema>

export const acceptInviteSchema = z.object({
  password: z.string().min(8).max(128),
})

export type AcceptInviteDto = z.infer<typeof acceptInviteSchema>
