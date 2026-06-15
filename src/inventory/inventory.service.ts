import { Injectable } from '@nestjs/common'
import { BookingStatus, type Prisma } from '@prisma/client'
import { NoAvailabilityError } from '../common/errors/domain.errors'
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
   * for the same facility, preventing overselling under concurrent load.
   */
  async holdSlot(
    params: {
      facilityId: string
      startsAt: Date
      endsAt: Date
      quotedPriceCents: number
      vehiclePlate: string
      vehicleType: string
      accessCode: string
      idempotencyKey?: string
      userId?: string
      vehicleId?: string
      guestEmail?: string
      guestPhone?: string
      sourceChannel?: string
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
        select: { onlineQuota: true, isActive: true, isVerified: true },
      })

      if (!facility?.isActive || !facility.isVerified) {
        throw new Error(`Facility ${params.facilityId} is not available for booking`)
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
          guestEmail: params.guestEmail,
          guestPhone: params.guestPhone,
          vehiclePlate: params.vehiclePlate,
          vehicleType: params.vehicleType as never,
          startsAt: params.startsAt,
          endsAt: params.endsAt,
          quotedPriceCents: params.quotedPriceCents,
          accessCode: params.accessCode,
          idempotencyKey: params.idempotencyKey,
          sourceChannel: (params.sourceChannel as never) ?? 'WEB',
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

    return this.prisma.$transaction(run, {
      isolationLevel: 'Serializable',
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
          AND: [
            { status: BookingStatus.PENDING_PAYMENT },
            { expiresAt: { lt: new Date() } },
          ],
        },
        // Overlap condition: booking starts before requested end AND ends after requested start
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    })
  }
}
