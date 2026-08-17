import {
  BookingStatus,
  FacilityKind,
  PrismaClient,
  UserRole,
  VehicleType,
  type Facility,
  type ParkingOperator,
} from '@prisma/client'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import request from 'supertest'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import {
  seedBooking,
  seedFacility,
  seedFacilityManager,
  seedOperator,
  seedTariffPlan,
  seedUser,
} from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'
const CENTRE = { lat: 37.9838, lng: 23.7275 }
const FUTURE = new Date('2027-01-10T10:00:00.000Z')
const FUTURE_END = new Date('2027-01-10T12:00:00.000Z')

/**
 * `kind` decides whether a facility can be quoted, booked, listed publicly or saved, so it
 * is platform-admin territory and a transition out of BUSINESS is a state change with
 * consequences — not a field edit.
 */
describe('facility kind (e2e)', () => {
  let app: NestFastifyApplication
  let raw: PrismaClient

  let operator: ParkingOperator
  let facility: Facility
  let operatorToken: string
  let platformToken: string

  beforeAll(async () => {
    const testApp = await createTestApp()
    app = testApp.app
    raw = new PrismaClient()
    await raw.$connect()
  })

  afterAll(async () => {
    await raw.$disconnect()
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(raw)
    resetThrottle(app)

    operator = await seedOperator(raw)
    facility = await seedFacility(raw, { operatorId: operator.id, ...CENTRE })
    const [operatorAdmin, platformAdmin] = await Promise.all([
      seedUser(raw, { role: UserRole.OPERATOR_ADMIN, operatorId: operator.id }),
      seedUser(raw, { role: UserRole.PLATFORM_ADMIN }),
    ])
    // Prisma-seeded facility, so the create endpoint's auto-assign never ran.
    await seedFacilityManager(raw, { facilityId: facility.id, userId: operatorAdmin.id })
    operatorToken = bearerToken(operatorAdmin)
    platformToken = bearerToken(platformAdmin)
  })

  function patchFacility(id: string, token: string, body: object) {
    return request(app.getHttpServer())
      .patch(`${API}/facilities/${id}`)
      .set('authorization', `Bearer ${token}`)
      .send(body)
  }

  it('a platform admin may change the kind, and the audit row names both ends', async () => {
    const res = await patchFacility(facility.id, platformToken, {
      kind: FacilityKind.FREE_PUBLIC,
    }).expect(200)

    expect((res.body as { kind: FacilityKind }).kind).toBe(FacilityKind.FREE_PUBLIC)
    expect((await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })).kind).toBe(
      FacilityKind.FREE_PUBLIC,
    )

    const audit = await raw.auditLog.findFirstOrThrow({
      where: { entityId: facility.id, action: 'facility.updated' },
    })
    expect(audit.payload).toEqual({
      kindFrom: FacilityKind.BUSINESS,
      kindTo: FacilityKind.FREE_PUBLIC,
    })
  })

  it('an operator admin is refused, and the facility keeps its kind', async () => {
    await patchFacility(facility.id, operatorToken, { kind: FacilityKind.FREE_PUBLIC }).expect(403)

    expect((await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })).kind).toBe(
      FacilityKind.BUSINESS,
    )
  })

  it('an operator admin may still edit the fields it owns', async () => {
    await patchFacility(facility.id, operatorToken, { name: 'Renamed' }).expect(200)

    expect((await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })).name).toBe(
      'Renamed',
    )
  })

  it('rejects a kind outside the enum before any authorization decision', async () => {
    await patchFacility(facility.id, platformToken, { kind: 'NOT_A_KIND' }).expect(400)
  })

  // Leaving BUSINESS strands whatever has already been sold: TariffService quotes only
  // BUSINESS facilities. No force escape hatch here by design.
  it('refuses to leave BUSINESS while bookings are still to be honoured', async () => {
    const consumer = await seedUser(raw)
    await seedBooking(raw, {
      facilityId: facility.id,
      userId: consumer.id,
      startsAt: FUTURE,
      endsAt: FUTURE_END,
      status: BookingStatus.CONFIRMED,
    })

    const res = await patchFacility(facility.id, platformToken, {
      kind: FacilityKind.RESTRICTED,
    }).expect(409)

    expect((res.body as { message: string }).message).toContain('1 booking(s)')
    expect((await raw.facility.findUniqueOrThrow({ where: { id: facility.id } })).kind).toBe(
      FacilityKind.BUSINESS,
    )
  })

  it('allows the change once the outstanding bookings are history', async () => {
    const consumer = await seedUser(raw)
    await seedBooking(raw, {
      facilityId: facility.id,
      userId: consumer.id,
      startsAt: new Date('2026-01-10T10:00:00.000Z'),
      endsAt: new Date('2026-01-10T12:00:00.000Z'),
      status: BookingStatus.CHECKED_OUT,
    })

    await patchFacility(facility.id, platformToken, { kind: FacilityKind.RESTRICTED }).expect(200)
  })

  // Dead pricing state otherwise, and it would come back the instant an admin flipped the
  // facility to BUSINESS again.
  it('clears the tariff assignments the facility can no longer use', async () => {
    const plan = await seedTariffPlan(raw, { operatorId: operator.id })
    await raw.facilityTariffAssignment.create({
      data: { facilityId: facility.id, tariffPlanId: plan.id, vehicleType: VehicleType.CAR },
    })

    await patchFacility(facility.id, platformToken, { kind: FacilityKind.FREE_PUBLIC }).expect(200)

    expect(await raw.facilityTariffAssignment.count({ where: { facilityId: facility.id } })).toBe(0)
  })

  it('moving INTO business keeps the assignments and asks nothing about bookings', async () => {
    await raw.facility.update({
      where: { id: facility.id },
      data: { kind: FacilityKind.UNKNOWN },
    })
    const plan = await seedTariffPlan(raw, { operatorId: operator.id })
    await raw.facilityTariffAssignment.create({
      data: { facilityId: facility.id, tariffPlanId: plan.id, vehicleType: VehicleType.CAR },
    })

    await patchFacility(facility.id, platformToken, { kind: FacilityKind.BUSINESS }).expect(200)

    expect(await raw.facilityTariffAssignment.count({ where: { facilityId: facility.id } })).toBe(1)
  })

  it('create defaults to BUSINESS when no kind is given', async () => {
    const otherOperator = await seedOperator(raw)
    const res = await request(app.getHttpServer())
      .post(`${API}/facilities`)
      .set('authorization', `Bearer ${platformToken}`)
      .send({
        operatorId: otherOperator.id,
        name: 'New Lot',
        address: '2 Test Street',
        lat: CENTRE.lat,
        lng: CENTRE.lng,
        totalCapacity: 10,
        onlineQuota: 5,
        vehicleTypes: ['car'],
        openingHours: { is24h: true },
      })
      .expect(201)

    expect((res.body as { kind: FacilityKind }).kind).toBe(FacilityKind.BUSINESS)
  })

  it('a platform admin may create a facility with a non-BUSINESS kind directly', async () => {
    const otherOperator = await seedOperator(raw)
    const res = await request(app.getHttpServer())
      .post(`${API}/facilities`)
      .set('authorization', `Bearer ${platformToken}`)
      .send({
        operatorId: otherOperator.id,
        name: 'New Lot',
        address: '2 Test Street',
        lat: CENTRE.lat,
        lng: CENTRE.lng,
        kind: FacilityKind.FREE_PUBLIC,
      })
      .expect(201)

    expect((res.body as { kind: FacilityKind }).kind).toBe(FacilityKind.FREE_PUBLIC)
  })

  it('an operator admin may not set a kind on create', async () => {
    await request(app.getHttpServer())
      .post(`${API}/facilities`)
      .set('authorization', `Bearer ${operatorToken}`)
      .send({
        operatorId: operator.id,
        name: 'New Lot',
        address: '2 Test Street',
        lat: CENTRE.lat,
        lng: CENTRE.lng,
        totalCapacity: 10,
        onlineQuota: 5,
        vehicleTypes: ['car'],
        openingHours: { is24h: true },
        kind: FacilityKind.FREE_PUBLIC,
      })
      .expect(403)
  })
})
