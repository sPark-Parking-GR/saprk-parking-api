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

export interface INotificationProvider {
  readonly providerName: string
  sendBookingConfirmation(data: BookingNotificationData): Promise<void>
  sendBookingCancellation(data: BookingNotificationData): Promise<void>
}
