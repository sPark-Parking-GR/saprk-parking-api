import { randomUUID } from 'node:crypto'
import {
  BookingStatus,
  FacilityKind,
  OperatorMemberRole,
  OperatorStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
  UserRole,
  VehicleType,
} from '@prisma/client'
import type { Booking, Facility, ParkingOperator, Payment, User } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

/**
 * The ingestion pipeline's synthetic owner for un-onboarded imports. It is the one
 * operator exempted from the `Facility_operatorId_claimed_key` partial unique index, so
 * it is also the only way to seed more than one facility under a single operator.
 */
export const UNCLAIMED_OPERATOR_ID = 'osm-unclaimed-operator'

function uniqueSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

export interface OperatorSeed {
  id?: string
  name?: string
  status?: OperatorStatus
}

export function seedOperator(
  prisma: PrismaClient,
  seed: OperatorSeed = {},
): Promise<ParkingOperator> {
  return prisma.parkingOperator.create({
    data: {
      ...(seed.id ? { id: seed.id } : {}),
      name: seed.name ?? `Operator ${uniqueSuffix()}`,
      status: seed.status ?? OperatorStatus.VERIFIED,
    },
  })
}

export function seedUnclaimedOperator(prisma: PrismaClient): Promise<ParkingOperator> {
  return seedOperator(prisma, { id: UNCLAIMED_OPERATOR_ID, name: 'Unclaimed imports' })
}

export interface UserSeed {
  role?: UserRole
  email?: string
  operatorId?: string
  memberRole?: OperatorMemberRole
}

export async function seedUser(prisma: PrismaClient, seed: UserSeed = {}): Promise<User> {
  const user = await prisma.user.create({
    data: {
      email: seed.email ?? `${uniqueSuffix()}@e2e.invalid`,
      role: seed.role ?? UserRole.USER,
      emailVerified: true,
    },
  })

  if (seed.operatorId) {
    await prisma.operatorMembership.create({
      data: {
        operatorId: seed.operatorId,
        userId: user.id,
        role: seed.memberRole ?? OperatorMemberRole.ADMIN,
      },
    })
  }

  return user
}

export interface FacilitySeed {
  operatorId: string
  lat: number
  lng: number
  name?: string
  address?: string
  kind?: FacilityKind
  isActive?: boolean
  isVerified?: boolean
  onlineQuota?: number
  totalCapacity?: number
  vehicleTypes?: VehicleType[]
  rank?: number
  createdAt?: Date
}

export function seedFacility(prisma: PrismaClient, seed: FacilitySeed): Promise<Facility> {
  return prisma.facility.create({
    data: {
      operatorId: seed.operatorId,
      name: seed.name ?? `Facility ${uniqueSuffix()}`,
      address: seed.address ?? '1 Test Street',
      lat: new Prisma.Decimal(seed.lat),
      lng: new Prisma.Decimal(seed.lng),
      totalCapacity: seed.totalCapacity ?? 100,
      onlineQuota: seed.onlineQuota ?? 10,
      vehicleTypes: seed.vehicleTypes ?? [VehicleType.CAR],
      openingHoursJson: { is24h: true },
      amenities: [],
      isActive: seed.isActive ?? true,
      isVerified: seed.isVerified ?? true,
      kind: seed.kind ?? FacilityKind.BUSINESS,
      rank: seed.rank ?? 0,
      ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
    },
  })
}

export interface OwnershipSeed {
  facilityId: string
  operatorId: string
  from: Date
  to?: Date
}

// Nothing in `src/` writes this table — only the migration backfill does — so analytics
// fixtures have to declare ownership explicitly. See the findings for why that matters.
export function seedOwnership(prisma: PrismaClient, seed: OwnershipSeed): Promise<unknown> {
  return prisma.facilityOwnershipPeriod.create({
    data: {
      facilityId: seed.facilityId,
      operatorId: seed.operatorId,
      from: seed.from,
      to: seed.to ?? null,
    },
  })
}

export interface TariffPlanSeed {
  operatorId: string
  name?: string
  isDefault?: boolean
}

export function seedTariffPlan(prisma: PrismaClient, seed: TariffPlanSeed) {
  return prisma.tariffPlan.create({
    data: {
      operatorId: seed.operatorId,
      name: seed.name ?? `Plan ${uniqueSuffix()}`,
      isDefault: seed.isDefault ?? false,
      vehicleTypes: [],
    },
  })
}

export interface BookingSeed {
  facilityId: string
  userId: string
  startsAt: Date
  endsAt: Date
  status?: BookingStatus
  quotedPriceCents?: number
  vehicleType?: VehicleType
  currency?: string
}

export function seedBooking(prisma: PrismaClient, seed: BookingSeed): Promise<Booking> {
  return prisma.booking.create({
    data: {
      facilityId: seed.facilityId,
      userId: seed.userId,
      vehiclePlate: `E2E${uniqueSuffix().slice(0, 5).toUpperCase()}`,
      vehicleType: seed.vehicleType ?? VehicleType.CAR,
      startsAt: seed.startsAt,
      endsAt: seed.endsAt,
      quotedPriceCents: seed.quotedPriceCents ?? 1_000,
      currency: seed.currency ?? 'EUR',
      status: seed.status ?? BookingStatus.CONFIRMED,
      accessCode: `AC${uniqueSuffix().toUpperCase()}`,
    },
  })
}

export interface PaymentSeed {
  bookingId: string
  amountCents: number
  /** The settlement instant every analytics range filters on. */
  createdAt: Date
  status?: PaymentStatus
  currency?: string
}

export function seedPayment(prisma: PrismaClient, seed: PaymentSeed): Promise<Payment> {
  return prisma.payment.create({
    data: {
      bookingId: seed.bookingId,
      amountCents: seed.amountCents,
      currency: seed.currency ?? 'EUR',
      provider: 'mock',
      providerPaymentId: `pi_${uniqueSuffix()}`,
      status: seed.status ?? PaymentStatus.SUCCEEDED,
      idempotencyKey: `idem_${uniqueSuffix()}`,
      createdAt: seed.createdAt,
    },
  })
}

export interface RefundSeed {
  bookingId: string
  paymentId: string
  amountCents: number
  status?: RefundStatus
  currency?: string
}

export function seedRefund(prisma: PrismaClient, seed: RefundSeed): Promise<unknown> {
  return prisma.refund.create({
    data: {
      bookingId: seed.bookingId,
      paymentId: seed.paymentId,
      amountCents: seed.amountCents,
      currency: seed.currency ?? 'EUR',
      status: seed.status ?? RefundStatus.SUCCEEDED,
    },
  })
}
