import { z } from 'zod'

export const updateMobileProfileSchema = z.object({
  pushToken: z.string().trim().min(1).max(512).optional(),
  locale: z.string().trim().min(2).max(35).optional(),
  appVersion: z.string().trim().min(1).max(40).optional(),
})

export type UpdateMobileProfileDto = z.infer<typeof updateMobileProfileSchema>
