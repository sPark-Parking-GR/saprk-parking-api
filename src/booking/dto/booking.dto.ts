import { VehicleType } from '@prisma/client'
import { z } from 'zod'

export const createBookingSchema = z
  .object({
    facilityId: z.string().min(1),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    vehicleType: z.nativeEnum(VehicleType),
    vehiclePlate: z.string().min(1).max(16),
    vehicleId: z.string().optional(),
    guestEmail: z.string().email().optional(),
    guestPhone: z.string().min(5).max(20).optional(),
    sourceChannel: z.enum(['WEB', 'MOBILE', 'API']).optional(),
  })
  .refine((data) => data.endsAt > data.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  })

export type CreateBookingDto = z.infer<typeof createBookingSchema>
