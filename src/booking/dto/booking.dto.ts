import { BookingStatus, VehicleType } from '@prisma/client'
import { z } from 'zod'
import {
  BOOKING_BACKDATE_GRACE_MINUTES,
  MAX_BOOKING_DURATION_MINUTES,
} from '../../tariff/tariff.types'

export const createBookingSchema = z
  .object({
    facilityId: z.string().min(1),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    vehicleType: z.nativeEnum(VehicleType),
    vehiclePlate: z.string().min(1).max(16),
    vehicleId: z.string().optional(),
    // Required, not defaulted: with mobile the only consumer origin, a server-side
    // default would silently stamp every row with the wrong channel.
    sourceChannel: z.enum(['WEB', 'MOBILE', 'API']),
  })
  .refine((data) => data.endsAt > data.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  })
  .refine(
    (data) => data.startsAt.getTime() >= Date.now() - BOOKING_BACKDATE_GRACE_MINUTES * 60_000,
    {
      message: `startsAt cannot be more than ${BOOKING_BACKDATE_GRACE_MINUTES} minutes in the past`,
      path: ['startsAt'],
    },
  )
  .refine(
    (data) =>
      data.endsAt.getTime() - data.startsAt.getTime() <= MAX_BOOKING_DURATION_MINUTES * 60_000,
    {
      message: `Booking duration cannot exceed ${MAX_BOOKING_DURATION_MINUTES} minutes`,
      path: ['endsAt'],
    },
  )

export type CreateBookingDto = z.infer<typeof createBookingSchema>

export const listBookingsSchema = z.object({
  status: z.nativeEnum(BookingStatus).optional(),
  facilityId: z.string().min(1).optional(),
  q: z.string().trim().min(1).max(64).optional(),
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(100).default(20),
})

export type ListBookingsDto = z.infer<typeof listBookingsSchema>
