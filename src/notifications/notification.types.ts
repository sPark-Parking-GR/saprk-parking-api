export interface BookingNotificationData {
  bookingId: string
  accessCode: string
  facilityName: string
  startsAt: Date
  endsAt: Date
  amountCents: number
  currency: string
  recipientEmail: string
}
