import { PrismaClient, VehicleType, TariffType, OperatorStatus } from '@prisma/client'

const prisma = new PrismaClient()

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

    // Tariff plan per facility
    const plan = await prisma.tariffPlan.upsert({
      where: { id: `seed-plan-${facility.id}` },
      update: {},
      create: {
        id: `seed-plan-${facility.id}`,
        facilityId: facility.id,
        name: 'Standard',
        isDefault: true,
        isActive: true,
      },
    })

    // Rules: hourly, daily, overnight
    const rules = [
      {
        id: `seed-rule-hourly-${facility.id}`,
        planId: plan.id,
        type: TariffType.HOURLY,
        vehicleTypes: [VehicleType.CAR, VehicleType.MOTORCYCLE],
        priceCents: 200,
        sortOrder: 1,
      },
      {
        id: `seed-rule-daily-${facility.id}`,
        planId: plan.id,
        type: TariffType.DAILY,
        vehicleTypes: [VehicleType.CAR],
        minDurationMinutes: 60 * 6,
        priceCents: 1500,
        sortOrder: 2,
      },
      {
        id: `seed-rule-overnight-${facility.id}`,
        planId: plan.id,
        type: TariffType.OVERNIGHT,
        vehicleTypes: [],
        priceCents: 800,
        sortOrder: 3,
      },
      {
        id: `seed-rule-van-${facility.id}`,
        planId: plan.id,
        type: TariffType.HOURLY,
        vehicleTypes: [VehicleType.VAN, VehicleType.TRUCK],
        priceCents: 350,
        sortOrder: 4,
      },
    ]

    for (const rule of rules) {
      await prisma.tariffRule.upsert({
        where: { id: rule.id },
        update: {},
        create: rule,
      })
    }
  }

  console.warn(`Seed complete: ${facilities.length} facilities across Athens and Thessaloniki.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
