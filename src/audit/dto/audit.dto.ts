import { z } from 'zod'

export const listAuditLogSchema = z.object({
  skip: z.coerce.number().int().nonnegative().default(0),
  take: z.coerce.number().int().positive().max(100).default(20),
})

export type ListAuditLogDto = z.infer<typeof listAuditLogSchema>
