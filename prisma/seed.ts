import {
  PrismaClient,
  VehicleType,
  OperatorStatus,
  RateUnit,
  CapScope,
  UserRole,
  OperatorMemberRole,
} from '@prisma/client'
import { hashPassword } from '@spark/auth'

const prisma = new PrismaClient()

const DEV_PASSWORD = 'sPark!Dev2026'

async function main() {
  // ── Operators ──────────────────────────────────────────────────────────────

  const opAthens = await prisma.parkingOperator.upsert({
    where: { taxId: '123456789' },
    update: {},
    create: {
      name: 'Athens Central Parking',
      legalName: 'Athens Central Parking SA',
      taxId: '123456789',
      status: OperatorStatus.VERIFIED,
      verifiedAt: new Date(),
    },
  })

  const opThess = await prisma.parkingOperator.upsert({
    where: { taxId: '987654321' },
    update: {},
    create: {
      name: 'Thessaloniki Smart Park',
      legalName: 'Thessaloniki Smart Park IKE',
      taxId: '987654321',
      status: OperatorStatus.VERIFIED,
      verifiedAt: new Date(),
    },
  })

  // ── Users ────────────────────────────────────────────────────────────────────

  await seedUsers(opAthens.id, opThess.id)

  // ── Facilities ─────────────────────────────────────────────────────────────

  const facilities = [
    {
      operatorId: opAthens.id,
      name: 'Syntagma Underground Parking',
      address: 'Πλατεία Συντάγματος, Αθήνα 105 57',
      lat: 37.9754,
      lng: 23.7348,
      totalCapacity: 250,
      onlineQuota: 180,
      vehicleTypes: [VehicleType.CAR, VehicleType.MOTORCYCLE],
      amenities: ['24h_access', 'cctv', 'disabled_spaces'],
    },
    {
      operatorId: opAthens.id,
      name: 'Monastiraki Parking',
      address: 'Μοναστηράκι, Αθήνα 105 55',
      lat: 37.9756,
      lng: 23.7257,
      totalCapacity: 120,
      onlineQuota: 80,
      vehicleTypes: [VehicleType.CAR, VehicleType.MOTORCYCLE, VehicleType.VAN],
      heightRestrictionCm: 210,
      amenities: ['cctv', 'covered'],
    },
    {
      operatorId: opAthens.id,
      name: 'Athens Airport Express Park',
      address: 'Αερολιμένας Αθηνών, Σπάτα 190 04',
      lat: 37.9364,
      lng: 23.9445,
      totalCapacity: 500,
      onlineQuota: 400,
      vehicleTypes: [VehicleType.CAR, VehicleType.VAN, VehicleType.TRUCK],
      amenities: ['24h_access', 'cctv', 'shuttle', 'ev_charging'],
    },
    {
      operatorId: opThess.id,
      name: 'Aristotelous Square Parking',
      address: 'Πλατεία Αριστοτέλους, Θεσσαλονίκη 546 24',
      lat: 40.6333,
      lng: 22.9425,
      totalCapacity: 200,
      onlineQuota: 140,
      vehicleTypes: [VehicleType.CAR, VehicleType.MOTORCYCLE],
      amenities: ['cctv', 'covered', 'disabled_spaces'],
    },
    {
      operatorId: opThess.id,
      name: 'Thessaloniki Port Parking',
      address: 'Λιμάνι Θεσσαλονίκης, Θεσσαλονίκη 546 26',
      lat: 40.6366,
      lng: 22.9375,
      totalCapacity: 300,
      onlineQuota: 220,
      vehicleTypes: [VehicleType.CAR, VehicleType.VAN, VehicleType.TRUCK],
      heightRestrictionCm: 300,
      amenities: ['24h_access', 'cctv'],
    },
  ]

  for (const data of facilities) {
    const facility = await prisma.facility.upsert({
      where: {
        id: `seed-${data.name.toLowerCase().replace(/\s+/g, '-')}`,
      },
      update: {},
      create: {
        id: `seed-${data.name.toLowerCase().replace(/\s+/g, '-')}`,
        operatorId: data.operatorId,
        name: data.name,
        address: data.address,
        lat: data.lat,
        lng: data.lng,
        totalCapacity: data.totalCapacity,
        onlineQuota: data.onlineQuota,
        vehicleTypes: data.vehicleTypes,
        heightRestrictionCm: data.heightRestrictionCm,
        openingHoursJson: { is24h: true },
        amenities: data.amenities,
        cancellationPolicy: 'Free cancellation up to 1 hour before arrival.',
        isActive: true,
        isVerified: true,
      },
    })

    await seedTariff(facility.id, data.operatorId, data.name)
  }

  console.warn(`Seed complete: ${facilities.length} facilities across Athens and Thessaloniki.`)
}

async function seedUsers(athensOperatorId: string, thessOperatorId: string): Promise<void> {
  const passwordHash = hashPassword(DEV_PASSWORD)

  const accounts: Array<{
    email: string
    role: UserRole
    displayName: string
    membership?: { operatorId: string; role: OperatorMemberRole }
  }> = [
    { email: 'superadmin@spark.gr', role: UserRole.PLATFORM_ADMIN, displayName: 'Platform Super Admin' },
    {
      email: 'admin.athens@spark.gr',
      role: UserRole.OPERATOR_ADMIN,
      displayName: 'Athens Operator Admin',
      membership: { operatorId: athensOperatorId, role: OperatorMemberRole.ADMIN },
    },
    {
      email: 'staff.athens@spark.gr',
      role: UserRole.OPERATOR_STAFF,
      displayName: 'Athens Operator Staff',
      membership: { operatorId: athensOperatorId, role: OperatorMemberRole.STAFF },
    },
    {
      email: 'admin.thessaloniki@spark.gr',
      role: UserRole.OPERATOR_ADMIN,
      displayName: 'Thessaloniki Operator Admin',
      membership: { operatorId: thessOperatorId, role: OperatorMemberRole.ADMIN },
    },
  ]

  for (const account of accounts) {
    const user = await prisma.user.upsert({
      where: { email: account.email },
      update: { passwordHash, role: account.role, displayName: account.displayName, emailVerified: true },
      create: {
        email: account.email,
        passwordHash,
        role: account.role,
        displayName: account.displayName,
        emailVerified: true,
      },
    })

    if (account.membership) {
      await prisma.operatorMembership.upsert({
        where: {
          operatorId_userId: { operatorId: account.membership.operatorId, userId: user.id },
        },
        update: { role: account.membership.role },
        create: {
          operatorId: account.membership.operatorId,
          userId: user.id,
          role: account.membership.role,
        },
      })
    }
  }

  console.warn(
    `Seeded ${accounts.length} dashboard users (password: "${DEV_PASSWORD}"):\n` +
      accounts.map((a) => `  - ${a.email} [${a.role}]`).join('\n'),
  )
}

async function seedTariff(facilityId: string, operatorId: string, facilityName: string): Promise<void> {
  if (facilityName === 'Syntagma Underground Parking') {
    await seedSyntagma(facilityId, operatorId)
  } else if (facilityName === 'Monastiraki Parking') {
    await seedMonastiraki(facilityId, operatorId)
  } else if (facilityName === 'Athens Airport Express Park') {
    await seedAirport(facilityId, operatorId)
  } else if (facilityName === 'Aristotelous Square Parking') {
    await seedAristotelous(facilityId, operatorId)
  } else if (facilityName === 'Thessaloniki Port Parking') {
    await seedPort(facilityId, operatorId)
  }
}

async function assignVehicleType(
  facilityId: string,
  vehicleType: VehicleType,
  tariffPlanId: string,
): Promise<void> {
  await prisma.facilityTariffAssignment.deleteMany({ where: { facilityId, vehicleType } })
  await prisma.facilityTariffAssignment.create({
    data: { id: `seed-assign-${vehicleType}-${facilityId}`, facilityId, tariffPlanId, vehicleType },
  })
}

async function seedSyntagma(facilityId: string, operatorId: string): Promise<string> {
  const planId = `seed-plan-${facilityId}`
  // Only one active default per operator (partial unique index) — clear any other
  // plan currently holding it before this upsert claims it, so re-seeding an
  // already-migrated DB (where the backfill may have picked a different plan) is
  // deterministic rather than racing the unique constraint.
  await prisma.tariffPlan.updateMany({
    where: { operatorId, isDefault: true, id: { not: planId } },
    data: { isDefault: false },
  })
  await prisma.tariffPlan.upsert({
    where: { id: planId },
    update: { isDefault: true },
    create: {
      id: planId,
      operatorId,
      name: 'Standard',
      isActive: true,
      isDefault: true,
      timezone: 'Europe/Athens',
      graceMinutes: 5,
      incrementMinutes: 60,
      vehicleTypes: [],
    },
  })

  const winDayId = `seed-win-day-${facilityId}`
  const winNightId = `seed-win-night-${facilityId}`

  await prisma.rateWindow.upsert({
    where: { id: winDayId },
    update: {},
    create: {
      id: winDayId,
      planId,
      label: 'Ημέρα',
      dayMask: 127,
      startMinute: 480,
      endMinute: 1200,
    },
  })

  await prisma.rateWindow.upsert({
    where: { id: winNightId },
    update: {},
    create: {
      id: winNightId,
      planId,
      label: 'Νύχτα',
      dayMask: 127,
      startMinute: 1200,
      endMinute: 480,
    },
  })

  const tier1Id = `seed-tier-1-${facilityId}`
  const tier2Id = `seed-tier-2-${facilityId}`

  await prisma.rateTier.upsert({
    where: { id: tier1Id },
    update: {},
    create: {
      id: tier1Id,
      planId,
      fromMinute: 0,
      toMinute: 30,
      unit: RateUnit.FLAT,
      blockMinutes: null,
    },
  })

  await prisma.rateTier.upsert({
    where: { id: tier2Id },
    update: {},
    create: {
      id: tier2Id,
      planId,
      fromMinute: 30,
      toMinute: null,
      unit: RateUnit.PER_BLOCK,
      blockMinutes: 60,
    },
  })

  const rates = [
    { id: `seed-rate-${tier1Id}-${winDayId}`, tierId: tier1Id, windowId: winDayId, priceCents: 200 },
    { id: `seed-rate-${tier1Id}-${winNightId}`, tierId: tier1Id, windowId: winNightId, priceCents: 100 },
    { id: `seed-rate-${tier2Id}-${winDayId}`, tierId: tier2Id, windowId: winDayId, priceCents: 250 },
    { id: `seed-rate-${tier2Id}-${winNightId}`, tierId: tier2Id, windowId: winNightId, priceCents: 120 },
  ]

  for (const rate of rates) {
    await prisma.tariffRate.upsert({
      where: { id: rate.id },
      update: {},
      create: { id: rate.id, tierId: rate.tierId, windowId: rate.windowId, priceCents: rate.priceCents, currency: 'EUR' },
    })
  }

  await prisma.rateCap.upsert({
    where: { id: `seed-cap-${facilityId}` },
    update: {},
    create: {
      id: `seed-cap-${facilityId}`,
      planId,
      windowMinutes: 1440,
      capCents: 1500,
      scope: CapScope.STAY,
    },
  })

  // Athens' operator default (isDefault above) — no explicit per-vehicle-type rows
  // needed, demonstrates the fallback-to-default resolution path.
  return planId
}

async function seedMonastiraki(facilityId: string, operatorId: string): Promise<string> {
  const planId = `seed-plan-${facilityId}`
  await prisma.tariffPlan.upsert({
    where: { id: planId },
    update: { isDefault: false },
    create: {
      id: planId,
      operatorId,
      name: 'Standard',
      isActive: true,
      timezone: 'Europe/Athens',
      graceMinutes: 0,
      incrementMinutes: 60,
      vehicleTypes: [],
    },
  })

  const winAllDayId = `seed-win-day-${facilityId}`

  await prisma.rateWindow.upsert({
    where: { id: winAllDayId },
    update: {},
    create: {
      id: winAllDayId,
      planId,
      label: 'Όλο το 24ωρο',
      dayMask: 127,
      startMinute: 0,
      endMinute: 1440,
    },
  })

  const tier1Id = `seed-tier-1-${facilityId}`

  await prisma.rateTier.upsert({
    where: { id: tier1Id },
    update: {},
    create: {
      id: tier1Id,
      planId,
      fromMinute: 0,
      toMinute: null,
      unit: RateUnit.PER_BLOCK,
      blockMinutes: 60,
    },
  })

  await prisma.tariffRate.upsert({
    where: { id: `seed-rate-${tier1Id}-${winAllDayId}` },
    update: {},
    create: {
      id: `seed-rate-${tier1Id}-${winAllDayId}`,
      tierId: tier1Id,
      windowId: winAllDayId,
      priceCents: 180,
      currency: 'EUR',
    },
  })

  // Not the operator default (Syntagma is) — needs explicit rows for every
  // vehicle type this facility accepts.
  await assignVehicleType(facilityId, VehicleType.CAR, planId)
  await assignVehicleType(facilityId, VehicleType.MOTORCYCLE, planId)
  await assignVehicleType(facilityId, VehicleType.VAN, planId)

  return planId
}

// Two plans exist for this facility, assigned per vehicle type rather than one
// plan for the whole facility — demonstrates the per-vehicle-type assignment
// capability (car/motorcycle bill under one plan, van/truck under another, same
// facility). Neither plan is the operator default (non-empty vehicleTypes
// disqualifies them), so every vehicle type needs an explicit row.
async function seedAirport(facilityId: string, operatorId: string): Promise<string> {
  const carPlanId = `seed-plan-${facilityId}`
  const vanPlanId = `seed-plan-van-${facilityId}`

  await prisma.tariffPlan.upsert({
    where: { id: carPlanId },
    update: {},
    create: {
      id: carPlanId,
      operatorId,
      name: 'CAR / MOTORCYCLE',
      isActive: true,
      timezone: 'Europe/Athens',
      graceMinutes: 10,
      incrementMinutes: 60,
      vehicleTypes: [VehicleType.CAR, VehicleType.MOTORCYCLE],
    },
  })

  await prisma.tariffPlan.upsert({
    where: { id: vanPlanId },
    update: {},
    create: {
      id: vanPlanId,
      operatorId,
      name: 'VAN / TRUCK',
      isActive: true,
      timezone: 'Europe/Athens',
      graceMinutes: 10,
      incrementMinutes: 60,
      vehicleTypes: [VehicleType.VAN, VehicleType.TRUCK],
    },
  })

  const winAllDayCarId = `seed-win-day-${facilityId}`
  const winAllDayVanId = `seed-win-day-van-${facilityId}`

  await prisma.rateWindow.upsert({
    where: { id: winAllDayCarId },
    update: {},
    create: {
      id: winAllDayCarId,
      planId: carPlanId,
      label: 'Όλο το 24ωρο',
      dayMask: 127,
      startMinute: 0,
      endMinute: 1440,
    },
  })

  await prisma.rateWindow.upsert({
    where: { id: winAllDayVanId },
    update: {},
    create: {
      id: winAllDayVanId,
      planId: vanPlanId,
      label: 'Όλο το 24ωρο',
      dayMask: 127,
      startMinute: 0,
      endMinute: 1440,
    },
  })

  const carTier1Id = `seed-tier-1-${facilityId}`
  const carTier2Id = `seed-tier-2-${facilityId}`
  const vanTier1Id = `seed-tier-1-van-${facilityId}`

  await prisma.rateTier.upsert({
    where: { id: carTier1Id },
    update: {},
    create: {
      id: carTier1Id,
      planId: carPlanId,
      fromMinute: 0,
      toMinute: 60,
      unit: RateUnit.PER_BLOCK,
      blockMinutes: 60,
    },
  })

  await prisma.rateTier.upsert({
    where: { id: carTier2Id },
    update: {},
    create: {
      id: carTier2Id,
      planId: carPlanId,
      fromMinute: 60,
      toMinute: null,
      unit: RateUnit.PER_BLOCK,
      blockMinutes: 60,
    },
  })

  await prisma.rateTier.upsert({
    where: { id: vanTier1Id },
    update: {},
    create: {
      id: vanTier1Id,
      planId: vanPlanId,
      fromMinute: 0,
      toMinute: null,
      unit: RateUnit.PER_BLOCK,
      blockMinutes: 60,
    },
  })

  const carRates = [
    { id: `seed-rate-${carTier1Id}-${winAllDayCarId}`, tierId: carTier1Id, windowId: winAllDayCarId, priceCents: 150 },
    { id: `seed-rate-${carTier2Id}-${winAllDayCarId}`, tierId: carTier2Id, windowId: winAllDayCarId, priceCents: 300 },
  ]

  for (const rate of carRates) {
    await prisma.tariffRate.upsert({
      where: { id: rate.id },
      update: {},
      create: { id: rate.id, tierId: rate.tierId, windowId: rate.windowId, priceCents: rate.priceCents, currency: 'EUR' },
    })
  }

  await prisma.tariffRate.upsert({
    where: { id: `seed-rate-${vanTier1Id}-${winAllDayVanId}` },
    update: {},
    create: {
      id: `seed-rate-${vanTier1Id}-${winAllDayVanId}`,
      tierId: vanTier1Id,
      windowId: winAllDayVanId,
      priceCents: 500,
      currency: 'EUR',
    },
  })

  await prisma.rateCap.upsert({
    where: { id: `seed-cap-${facilityId}` },
    update: {},
    create: {
      id: `seed-cap-${facilityId}`,
      planId: carPlanId,
      windowMinutes: 1440,
      capCents: 2500,
      scope: CapScope.STAY,
    },
  })

  await assignVehicleType(facilityId, VehicleType.CAR, carPlanId)
  await assignVehicleType(facilityId, VehicleType.MOTORCYCLE, carPlanId)
  await assignVehicleType(facilityId, VehicleType.VAN, vanPlanId)
  await assignVehicleType(facilityId, VehicleType.TRUCK, vanPlanId)

  return carPlanId
}

async function seedAristotelous(facilityId: string, operatorId: string): Promise<string> {
  const planId = `seed-plan-${facilityId}`
  await prisma.tariffPlan.updateMany({
    where: { operatorId, isDefault: true, id: { not: planId } },
    data: { isDefault: false },
  })
  await prisma.tariffPlan.upsert({
    where: { id: planId },
    update: { isDefault: true },
    create: {
      id: planId,
      operatorId,
      name: 'Standard',
      isActive: true,
      isDefault: true,
      timezone: 'Europe/Athens',
      graceMinutes: 15,
      incrementMinutes: 15,
      vehicleTypes: [],
    },
  })

  const winAllDayId = `seed-win-day-${facilityId}`

  await prisma.rateWindow.upsert({
    where: { id: winAllDayId },
    update: {},
    create: {
      id: winAllDayId,
      planId,
      label: 'Όλο το 24ωρο',
      dayMask: 127,
      startMinute: 0,
      endMinute: 1440,
    },
  })

  const tier1Id = `seed-tier-1-${facilityId}`

  await prisma.rateTier.upsert({
    where: { id: tier1Id },
    update: {},
    create: {
      id: tier1Id,
      planId,
      fromMinute: 0,
      toMinute: null,
      unit: RateUnit.PER_BLOCK,
      blockMinutes: 15,
    },
  })

  await prisma.tariffRate.upsert({
    where: { id: `seed-rate-${tier1Id}-${winAllDayId}` },
    update: {},
    create: {
      id: `seed-rate-${tier1Id}-${winAllDayId}`,
      tierId: tier1Id,
      windowId: winAllDayId,
      priceCents: 50,
      currency: 'EUR',
    },
  })

  await prisma.rateCap.upsert({
    where: { id: `seed-cap-${facilityId}` },
    update: {},
    create: {
      id: `seed-cap-${facilityId}`,
      planId,
      windowMinutes: 1440,
      capCents: 1200,
      scope: CapScope.STAY,
    },
  })

  // Thessaloniki's operator default (isDefault above) — no explicit rows needed.
  return planId
}

async function seedPort(facilityId: string, operatorId: string): Promise<string> {
  const planId = `seed-plan-${facilityId}`
  await prisma.tariffPlan.upsert({
    where: { id: planId },
    update: { isDefault: false },
    create: {
      id: planId,
      operatorId,
      name: 'Standard',
      isActive: true,
      timezone: 'Europe/Athens',
      graceMinutes: 0,
      incrementMinutes: 60,
      vehicleTypes: [],
    },
  })

  const winAllDayId = `seed-win-day-${facilityId}`

  await prisma.rateWindow.upsert({
    where: { id: winAllDayId },
    update: {},
    create: {
      id: winAllDayId,
      planId,
      label: 'Όλο το 24ωρο',
      dayMask: 127,
      startMinute: 0,
      endMinute: 1440,
    },
  })

  const tier1Id = `seed-tier-1-${facilityId}`

  await prisma.rateTier.upsert({
    where: { id: tier1Id },
    update: {},
    create: {
      id: tier1Id,
      planId,
      fromMinute: 0,
      toMinute: null,
      unit: RateUnit.FLAT,
      blockMinutes: null,
    },
  })

  await prisma.tariffRate.upsert({
    where: { id: `seed-rate-${tier1Id}-${winAllDayId}` },
    update: {},
    create: {
      id: `seed-rate-${tier1Id}-${winAllDayId}`,
      tierId: tier1Id,
      windowId: winAllDayId,
      priceCents: 800,
      currency: 'EUR',
    },
  })

  // Not the operator default (Aristotelous is) — needs explicit rows for every
  // vehicle type this facility accepts.
  await assignVehicleType(facilityId, VehicleType.CAR, planId)
  await assignVehicleType(facilityId, VehicleType.VAN, planId)
  await assignVehicleType(facilityId, VehicleType.TRUCK, planId)

  return planId
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
