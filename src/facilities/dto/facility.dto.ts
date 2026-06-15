import { VehicleType } from '@prisma/client'
import { z } from 'zod'

export const searchFacilitiesSchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radiusMeters: z.coerce.number().int().positive().max(50_000).default(2_000),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    vehicleType: z.nativeEnum(VehicleType).optional(),
  })
  .refine((data) => data.endsAt > data.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
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
