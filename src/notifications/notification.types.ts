export interface BookingNotificationData {
  bookingId: string
  accessCode: string
  facilityName: string
  startsAt: Date
  endsAt: Date
  amountCents: number
  currency: string
  recipientEmail: string
  // Looked up against MobileProfile to find a push token, if any — a driver who never
  // installed the app or never granted notification permission simply has none on file.
  recipientUserId: string
}
