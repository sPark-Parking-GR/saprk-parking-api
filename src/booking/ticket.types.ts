import type { BookingStatus, VehicleType } from '@prisma/client'

export type TicketVerdict =
  'valid' | 'invalid_signature' | 'outside_time_window' | 'already_used' | 'not_honourable'

export type TicketMethod = 'qr' | 'access_code'

export type CheckInOutcome = 'performed' | 'already_checked_in' | 'not_applicable'

// What an operator needs at the barrier to act on the verdict, and nothing more. qrSecret
// is structurally absent: the scan select that feeds this carries it, this shape does not.
export interface TicketBookingSummary {
  id: string
  accessCode: string
  status: BookingStatus
  startsAt: Date
  endsAt: Date
  vehiclePlate: string
  vehicleType: VehicleType
  facility: { id: string; name: string }
}

export interface TicketVerification {
  verdict: TicketVerdict
  valid: boolean
  method: TicketMethod
  /** null when the caller did not ask for autoCheckIn, or the verdict did not allow it. */
  checkIn: CheckInOutcome | null
  booking: TicketBookingSummary
}

export interface IssuedTicket {
  bookingId: string
  payload: string
  unixMinute: number
  expiresAt: Date
}
