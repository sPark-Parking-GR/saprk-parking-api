import { z } from 'zod'

export const listAuditLogSchema = z
  .object({
    skip: z.coerce.number().int().nonnegative().default(0),
    take: z.coerce.number().int().positive().max(100).default(20),
    actorId: z.string().min(1).optional(),
    // Free-text search over the actor's name/email, resolved to a set of actorIds in the
    // service. Takes precedence over actorId when both are given.
    actorQuery: z.string().min(1).max(200).optional(),
    action: z.string().min(1).max(200).optional(),
    entityType: z.string().min(1).max(100).optional(),
    entityId: z.string().min(1).optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.createdFrom && data.createdTo && data.createdFrom > data.createdTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'createdFrom must be before createdTo',
        path: ['createdFrom'],
      })
    }
  })

export type ListAuditLogDto = z.infer<typeof listAuditLogSchema>
