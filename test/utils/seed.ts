import { DEFAULT_STAFF_SCOPES } from '@spark/types'
import { randomUUID } from 'node:crypto'
import {
  BookingStatus,
  FacilityKind,
  OperatorMemberRole,
  OperatorStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
  SubscriptionStatus,
  UserRole,
  VehicleType,
} from '@prisma/client'
import type { Booking, Facility, ParkingOperator, Payment, User } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

/**
 * The ingestion pipeline's synthetic owner for un-onboarded imports. It is the one operator
 * exempted from subscription quotas entirely (see EntitlementService.isQuotaExempt), and it
 * was previously the one exempted by name from the `Facility_operatorId_claimed_key` partial
 * unique index that 20260803100000_subscription_entitlements dropped.
 */
export const UNCLAIMED_OPERATOR_ID = 'osm-unclaimed-operator'

/** Mirrors the row 20260803100000_subscription_entitlements seeds. */
export const STARTER_PLAN_ID = 'plan_starter'
export const STARTER_PLAN_CODE = 'starter'

export interface SubscriptionPlanSeed {
  id?: string
  code?: string
  name?: string
  maxFacilities?: number | null
  maxTariffPlans?: number | null
  maxStaffSeats?: number | null
  features?: string[]
  commissionBps?: number
  priceCents?: number
}

/**
 * `truncateAll` wipes SubscriptionPlan along with everything else, taking the Starter row
 * the migration seeded with it. Any suite whose code path resolves entitlements has to put
 * it back, or every operator without a live subscription resolves to a missing default plan
 * and fails closed with a 503 — which is the correct production behaviour and a useless
 * test failure.
 */
export function seedSubscriptionPlan(prisma: PrismaClient, seed: SubscriptionPlanSeed = {}) {
  return prisma.subscriptionPlan.create({
    data: {
      id: seed.id ?? STARTER_PLAN_ID,
      code: seed.code ?? STARTER_PLAN_CODE,
      name: seed.name ?? 'Starter',
      priceCents: seed.priceCents ?? 0,
      entitlements: {
        maxFacilities: seed.maxFacilities === undefined ? 1 : seed.maxFacilities,
        maxTariffPlans: seed.maxTariffPlans === undefined ? null : seed.maxTariffPlans,
        maxStaffSeats: seed.maxStaffSeats === undefined ? null : seed.maxStaffSeats,
        features: seed.features ?? [],
        commissionBps: seed.commissionBps ?? 0,
      },
    },
  })
}

export interface OperatorSubscriptionSeed {
  operatorId: string
  planId: string
  status?: SubscriptionStatus
  entitlementOverride?: Prisma.InputJsonValue
}

export function seedOperatorSubscription(prisma: PrismaClient, seed: OperatorSubscriptionSeed) {
  return prisma.operatorSubscription.create({
    data: {
      operatorId: seed.operatorId,
      planId: seed.planId,
      status: seed.status ?? SubscriptionStatus.ACTIVE,
      ...(seed.entitlementOverride === undefined
        ? {}
        : { entitlementOverride: seed.entitlementOverride }),
    },
  })
}

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
        // Mirrors what invite acceptance writes, so suites exercise a state that can
        // actually occur rather than a staff member with no scopes at all.
        scopes:
          (seed.memberRole ?? OperatorMemberRole.ADMIN) === OperatorMemberRole.STAFF
            ? [...DEFAULT_STAFF_SCOPES]
            : [],
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
  isPublished?: boolean
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
      isPublished: seed.isPublished ?? true,
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
  /** Set to mint a scannable ticket; production writes this only at confirm time. */
  qrSecret?: string
  /** Must satisfy the base32 alphabet when the booking is going to be scanned by code. */
  accessCode?: string
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
      accessCode: seed.accessCode ?? `AC${uniqueSuffix().toUpperCase()}`,
      ...(seed.qrSecret ? { qrSecret: seed.qrSecret } : {}),
    },
  })
}

export function seedSavedFacility(
  prisma: PrismaClient,
  seed: { userId: string; facilityId: string },
): Promise<unknown> {
  return prisma.savedFacility.create({ data: seed })
}

/**
 * Grants a user the per-user management assignment every operator-facing facility and
 * tariff-plan read now requires below platform admin. Resources created THROUGH the API get
 * this row automatically in the create transaction; anything seeded straight through Prisma
 * does not, so a fixture that skips it leaves its own operator staring at an empty list.
 *
 * `assignedBy` defaults to the assignee, matching what an auto-assign-on-create writes.
 */
export function seedFacilityManager(
  prisma: PrismaClient,
  seed: { facilityId: string; userId: string; assignedBy?: string },
): Promise<unknown> {
  return prisma.facilityManager.create({
    data: {
      facilityId: seed.facilityId,
      userId: seed.userId,
      assignedBy: seed.assignedBy ?? seed.userId,
    },
  })
}

export function seedTariffPlanManager(
  prisma: PrismaClient,
  seed: { tariffPlanId: string; userId: string; assignedBy?: string },
): Promise<unknown> {
  return prisma.tariffPlanManager.create({
    data: {
      tariffPlanId: seed.tariffPlanId,
      userId: seed.userId,
      assignedBy: seed.assignedBy ?? seed.userId,
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
