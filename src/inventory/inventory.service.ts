import { Injectable } from '@nestjs/common'
import { BookingStatus, FacilityKind, type Prisma } from '@prisma/client'
import { FacilityNotBookableError, NoAvailabilityError } from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'
import { BOOKING_HOLD_MINUTES } from '../tariff/tariff.types'

export interface AvailabilityCheck {
  facilityId: string
  startsAt: Date
  endsAt: Date
}

export interface AvailabilityResult {
  available: boolean
  onlineQuota: number
  overlappingCount: number
  remainingSlots: number
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async checkAvailability(check: AvailabilityCheck): Promise<AvailabilityResult> {
    const { facilityId, startsAt, endsAt } = check

    const facility = await this.prisma.facility.findUnique({
      where: { id: facilityId },
      select: { onlineQuota: true },
    })

    if (!facility) {
      return { available: false, onlineQuota: 0, overlappingCount: 0, remainingSlots: 0 }
    }

    const overlappingCount = await this.countOverlappingBookings(facilityId, startsAt, endsAt)
    const remainingSlots = facility.onlineQuota - overlappingCount

    return {
      available: remainingSlots > 0,
      onlineQuota: facility.onlineQuota,
      overlappingCount,
      remainingSlots: Math.max(0, remainingSlots),
    }
  }

  /**
   * Atomically verifies availability and creates a booking in PENDING_PAYMENT status.
   * Uses SELECT FOR UPDATE on the facility row to serialize concurrent booking attempts
   * for the same facility, preventing overselling without losing sellable slots.
   */
  async holdSlot(
    params: {
      facilityId: string
      startsAt: Date
      endsAt: Date
      quotedPriceCents: number
      /** Already deducted from quotedPriceCents by the quote; 0 when the rider has no perk. */
      discountCents: number
      vehiclePlate: string
      vehicleType: string
      accessCode: string
      tariffPlanId: string
      tariffPlanVersion: number
      userId: string
      sourceChannel: string
      idempotencyKey?: string
      vehicleId?: string
    },
    tx?: Prisma.TransactionClient,
  ): Promise<{ bookingId: string; expiresAt: Date }> {
    const run = async (client: Prisma.TransactionClient) => {
      // Acquire row-level lock on the facility to serialize concurrent holds
      await client.$executeRaw`
        SELECT id FROM "Facility" WHERE id = ${params.facilityId} FOR UPDATE
      `

      const facility = await client.facility.findUnique({
        where: { id: params.facilityId },
        select: { onlineQuota: true, isActive: true, isPublished: true, kind: true },
      })

      // Booking eligibility mirrors TariffService.computeQuote's own facility lookup
      // (isActive, isPublished, kind === BUSINESS) so holding without a prior quote
      // can't bypass it.
      if (!facility?.isActive || !facility.isPublished || facility.kind !== FacilityKind.BUSINESS) {
        throw new FacilityNotBookableError(params.facilityId)
      }

      const overlapping = await this.countOverlappingBookings(
        params.facilityId,
        params.startsAt,
        params.endsAt,
        client,
      )

      if (overlapping >= facility.onlineQuota) {
        throw new NoAvailabilityError(params.facilityId, params.startsAt, params.endsAt)
      }

      const expiresAt = new Date(Date.now() + BOOKING_HOLD_MINUTES * 60_000)

      const booking = await client.booking.create({
        data: {
          facilityId: params.facilityId,
          userId: params.userId,
          vehicleId: params.vehicleId,
          vehiclePlate: params.vehiclePlate,
          vehicleType: params.vehicleType as never,
          startsAt: params.startsAt,
          endsAt: params.endsAt,
          quotedPriceCents: params.quotedPriceCents,
          discountCents: params.discountCents,
          accessCode: params.accessCode,
          tariffPlanId: params.tariffPlanId,
          tariffPlanVersion: params.tariffPlanVersion,
          idempotencyKey: params.idempotencyKey,
          sourceChannel: params.sourceChannel as never,
          status: BookingStatus.PENDING_PAYMENT,
          expiresAt,
          statusHistory: {
            create: { status: BookingStatus.PENDING_PAYMENT },
          },
        },
        select: { id: true, expiresAt: true },
      })

      return { bookingId: booking.id, expiresAt: booking.expiresAt! }
    }

    if (tx) return run(tx)

    // Read Committed, not Serializable: the FOR UPDATE above is what serializes holds.
    // Under Serializable that lock stamps the tuple, so every waiter aborts with 40001
    // the instant the winner commits — before its own count can see the new booking, so
    // only one slot ever sells and the rest surface as raw aborts. Read Committed lets a
    // waiter re-read the committed state, count the winner, and reject with
    // NoAvailabilityError only once the quota is genuinely full.
    return this.prisma.$transaction(run, {
      isolationLevel: 'ReadCommitted',
    })
  }

  async releaseExpiredHolds(): Promise<number> {
    const result = await this.prisma.booking.updateMany({
      where: {
        status: BookingStatus.PENDING_PAYMENT,
        expiresAt: { lt: new Date() },
      },
      data: { status: BookingStatus.EXPIRED },
    })
    return result.count
  }

  /**
   * Overlapping active-booking counts for many facilities in a single query.
   * Replaces per-facility counts when checking availability across a search result set.
   */
  async countOverlappingByFacility(
    facilityIds: string[],
    startsAt: Date,
    endsAt: Date,
  ): Promise<Map<string, number>> {
    if (facilityIds.length === 0) return new Map()

    const groups = await this.prisma.booking.groupBy({
      by: ['facilityId'],
      where: {
        facilityId: { in: facilityIds },
        status: {
          in: [BookingStatus.CONFIRMED, BookingStatus.PENDING_PAYMENT, BookingStatus.CHECKED_IN],
        },
        NOT: {
          AND: [{ status: BookingStatus.PENDING_PAYMENT }, { expiresAt: { lt: new Date() } }],
        },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      _count: { _all: true },
    })

    return new Map(groups.map((g) => [g.facilityId, g._count._all]))
  }

  private async countOverlappingBookings(
    facilityId: string,
    startsAt: Date,
    endsAt: Date,
    client?: Prisma.TransactionClient,
  ): Promise<number> {
    const db = client ?? this.prisma

    return db.booking.count({
      where: {
        facilityId,
        status: {
          in: [BookingStatus.CONFIRMED, BookingStatus.PENDING_PAYMENT, BookingStatus.CHECKED_IN],
        },
        // Exclude expired holds
        NOT: {
          AND: [{ status: BookingStatus.PENDING_PAYMENT }, { expiresAt: { lt: new Date() } }],
        },
        // Overlap condition: booking starts before requested end AND ends after requested start
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    })
  }
}
