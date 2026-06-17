import { VehicleType } from '@prisma/client'
import { z } from 'zod'

export const searchFacilitiesSchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radiusMeters: z.coerce.number().int().positive().max(50_000).default(2_000),
    north: z.coerce.number().min(-90).max(90).optional(),
    south: z.coerce.number().min(-90).max(90).optional(),
    east: z.coerce.number().min(-180).max(180).optional(),
    west: z.coerce.number().min(-180).max(180).optional(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    vehicleType: z.nativeEnum(VehicleType).optional(),
  })
  .refine((data) => data.endsAt > data.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  })
  .superRefine((data, ctx) => {
    const corners = [data.north, data.south, data.east, data.west]
    const provided = corners.filter((v) => v !== undefined).length
    if (provided !== 0 && provided !== 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'north, south, east and west must be provided together',
        path: ['north'],
      })
      return
    }
    if (provided === 4) {
      if (data.south! >= data.north!) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'south must be less than north',
          path: ['south'],
        })
      }
      if (data.west! >= data.east!) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'west must be less than east',
          path: ['west'],
        })
      }
    }
  })

export type SearchFacilitiesDto = z.infer<typeof searchFacilitiesSchema>

export const quoteSchema = z
  .object({
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    vehicleType: z.nativeEnum(VehicleType),
  })
  .refine((data) => data.endsAt > data.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  })

export type QuoteDto = z.infer<typeof quoteSchema>
