import { FacilityKind, VehicleType } from '@prisma/client'
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

const lowercaseVehicleEnum = z.enum(['car', 'motorcycle', 'van', 'truck'])

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm')

export const openingHoursSchema = z.object({
  is24h: z.boolean(),
  schedule: z
    .record(z.string(), z.object({ open: timeOfDay, close: timeOfDay }).nullable())
    .optional(),
})

export const createFacilitySchema = z
  .object({
    name: z.string().min(1).max(200),
    address: z.string().min(1).max(300),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    totalCapacity: z.number().int().positive().max(100_000),
    onlineQuota: z.number().int().nonnegative().max(100_000),
    vehicleTypes: z.array(lowercaseVehicleEnum).min(1),
    heightRestrictionCm: z.number().int().positive().max(1_000).optional(),
    openingHours: openingHoursSchema,
    amenities: z.array(z.string().min(1).max(60)).max(50).default([]),
    cancellationPolicy: z.string().max(2_000).default(''),
    operatorId: z.string().min(1).optional(),
  })
  .refine((data) => data.onlineQuota <= data.totalCapacity, {
    message: 'onlineQuota cannot exceed totalCapacity',
    path: ['onlineQuota'],
  })

export type CreateFacilityDto = z.infer<typeof createFacilitySchema>

export const updateFacilitySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    address: z.string().min(1).max(300).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    totalCapacity: z.number().int().positive().max(100_000).optional(),
    onlineQuota: z.number().int().nonnegative().max(100_000).optional(),
    vehicleTypes: z.array(lowercaseVehicleEnum).min(1).optional(),
    heightRestrictionCm: z.number().int().positive().max(1_000).optional(),
    openingHours: openingHoursSchema.optional(),
    amenities: z.array(z.string().min(1).max(60)).max(50).optional(),
    cancellationPolicy: z.string().max(2_000).optional(),
    isActive: z.boolean().optional(),
    isVerified: z.boolean().optional(),
    rank: z.number().int().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  })
  .refine(
    (data) =>
      data.onlineQuota === undefined ||
      data.totalCapacity === undefined ||
      data.onlineQuota <= data.totalCapacity,
    { message: 'onlineQuota cannot exceed totalCapacity', path: ['onlineQuota'] },
  )

export type UpdateFacilityDto = z.infer<typeof updateFacilitySchema>

const booleanFromQuery = z.preprocess(
  (v) => (typeof v === 'string' ? v === 'true' : v),
  z.boolean().optional(),
)

export const listFacilitiesSchema = z.object({
  skip: z.coerce.number().int().nonnegative().default(0),
  take: z.coerce.number().int().positive().max(100).default(20),
  q: z.string().trim().max(200).optional(),
  isActive: booleanFromQuery,
  isVerified: booleanFromQuery,
  kind: z.nativeEnum(FacilityKind).optional(),
  operatorId: z.string().min(1).optional(),
})

export type ListFacilitiesDto = z.infer<typeof listFacilitiesSchema>

export const bulkFacilitySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  action: z.enum(['enable', 'disable', 'deploy', 'delete']),
})

export type BulkFacilityDto = z.infer<typeof bulkFacilitySchema>

export const adminMapSchema = z
  .object({
    north: z.coerce.number().min(-90).max(90),
    south: z.coerce.number().min(-90).max(90),
    east: z.coerce.number().min(-180).max(180),
    west: z.coerce.number().min(-180).max(180),
    q: z.string().trim().max(200).optional(),
    isActive: booleanFromQuery,
    isVerified: booleanFromQuery,
    kind: z.nativeEnum(FacilityKind).optional(),
    operatorId: z.string().min(1).optional(),
  })
  .refine((d) => d.south < d.north, {
    message: 'south must be less than north',
    path: ['south'],
  })
  .refine((d) => d.west < d.east, {
    message: 'west must be less than east',
    path: ['west'],
  })

export type AdminMapDto = z.infer<typeof adminMapSchema>
