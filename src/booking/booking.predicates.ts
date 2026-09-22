import { BookingStatus } from '@prisma/client'
import type { Prisma } from '@prisma/client'

// Bookings a shutdown would abandon: still to be honoured (CONFIRMED) or with a vehicle
// currently inside (CHECKED_IN), and not yet over. Everything else is history.
const UNHONOURED_BOOKING_STATUSES = [BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN]

/**
 * The one definition of "this facility still owes customers a place to park", shared by
 * FacilitiesService (delete, deactivate, kind change), LifecycleService (archive,
 * tombstone) and LifecycleImpactService (the dry run that must mirror them exactly).
 *
 * It lives here rather than next to any one of those because FacilitiesService now
 * delegates its delete to LifecycleService: keeping the predicate in facilities.service
 * would make the two files import each other.
 */
export function unhonouredBookingsWhere(facilityId: string | string[]): Prisma.BookingWhereInput {
  return {
    facilityId: Array.isArray(facilityId) ? { in: facilityId } : facilityId,
    status: { in: UNHONOURED_BOOKING_STATUSES },
    endsAt: { gt: new Date() },
  }
}
