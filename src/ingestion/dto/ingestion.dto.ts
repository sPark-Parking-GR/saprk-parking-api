import { VehicleType } from '@prisma/client'
import { z } from 'zod'
import { openingHoursSchema } from '../../facilities/dto/facility.dto'
import { DEFAULT_TILE_DEGREES } from '../ingestion.constants'

export const ingestRegionSchema = z
  .object({
    south: z.number().min(-90).max(90),
    west: z.number().min(-180).max(180),
    north: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
    tileDegrees: z.number().positive().max(1).default(DEFAULT_TILE_DEGREES),
  })
  .refine((b) => b.north > b.south, {
    message: 'north must be greater than south',
    path: ['north'],
  })
  .refine((b) => b.east > b.west, {
    message: 'east must be greater than west',
    path: ['east'],
  })

export type IngestRegionDto = z.infer<typeof ingestRegionSchema>

// Looser than the operator-facing createFacilitySchema: external sources often
// lack capacity, address or hours. Catalog rows are non-bookable, so zero capacity
// and empty address are acceptable here. Uses the Prisma VehicleType enum directly
// since this validates data written straight to the database, not API input.
export const ingestFacilitySchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(300),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  totalCapacity: z.number().int().min(0).max(100_000),
  vehicleTypes: z.array(z.nativeEnum(VehicleType)).min(1),
  heightRestrictionCm: z.number().int().positive().max(1_000).nullable(),
  openingHours: openingHoursSchema,
  amenities: z.array(z.string().min(1).max(60)).max(50),
})

export type IngestFacilityDto = z.infer<typeof ingestFacilitySchema>
