import { Module } from '@nestjs/common'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { OperatorStatus, UserRole } from '@prisma/client'
import request from 'supertest'
import { IngestionController } from '../../src/ingestion/ingestion.controller'
import { IngestionService } from '../../src/ingestion/ingestion.service'
import { RefreshService } from '../../src/ingestion/refresh.service'
import type { PrismaService } from '../../src/prisma/prisma.service'
import { bearerToken } from '../utils/auth'
import { truncateAll } from '../utils/db'
import { seedOperator, seedUser } from '../utils/seed'
import { createTestApp } from '../utils/test-app'
import { resetThrottle } from '../utils/throttle'

const API = '/api/v1'

const REGION = { south: 37.9, west: 23.7, north: 38.0, east: 23.8 }

// The real IngestionController over faked queue-backed services. The gate under test sits
// on the controller and a guard rejects long before a handler body would run, so the fakes
// only have to make the admitted case reach a response.
const ingestionStub = {
  enqueueRegion: async () => ({ tiles: 1 }),
  enqueueGoogleRegion: async () => ({ tiles: 1 }),
  enqueueSweep: async () => ({ queued: true }),
  enqueuePromotion: async () => ({ queued: true }),
  enqueueReclassify: async () => ({ queued: true }),
}

const refreshStub = { enqueue: async () => ({ queued: true }) }

@Module({
  controllers: [IngestionController],
  providers: [
    { provide: IngestionService, useValue: ingestionStub },
    { provide: RefreshService, useValue: refreshStub },
  ],
})
class StubIngestionModule {}

interface Endpoint {
  name: string
  method: 'get' | 'post'
  /** Resolved per test, because the operator rows are reseeded between them. */
  path: () => string
  body?: object
  /** What a platform admin gets once the gate has let it through. */
  admitted: number
}

/**
 * Every endpoint that `@Roles('platform_admin')` gated before the permission indirection
 * existed. The refactor changed which mechanism decides, never who is admitted, so this is
 * the regression guard for that claim — and it is deliberately exhaustive, not a sample.
 */
describe('platform permission gates (e2e)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService

  let platformToken: string
  let operatorAdminToken: string
  let operatorStaffToken: string
  let consumerToken: string
  let verifiedOperatorId: string
  let suspendedOperatorId: string

  beforeAll(async () => {
    const testApp = await createTestApp({ ingestionModule: StubIngestionModule })
    app = testApp.app
    prisma = testApp.prisma
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(prisma)
    resetThrottle(app)

    const [verified, suspended] = await Promise.all([
      seedOperator(prisma, { name: 'Verified', status: OperatorStatus.VERIFIED }),
      seedOperator(prisma, { name: 'Suspended', status: OperatorStatus.SUSPENDED }),
    ])
    verifiedOperatorId = verified.id
    suspendedOperatorId = suspended.id

    const [platformAdmin, operatorAdmin, operatorStaff, consumer] = await Promise.all([
      seedUser(prisma, { role: UserRole.PLATFORM_ADMIN }),
      seedUser(prisma, { role: UserRole.OPERATOR_ADMIN, operatorId: verified.id }),
      seedUser(prisma, { role: UserRole.OPERATOR_STAFF, operatorId: verified.id }),
      seedUser(prisma, { role: UserRole.USER }),
    ])
    platformToken = bearerToken(platformAdmin)
    operatorAdminToken = bearerToken(operatorAdmin)
    operatorStaffToken = bearerToken(operatorStaff)
    consumerToken = bearerToken(consumer)
  })

  function call(endpoint: Endpoint, token?: string) {
    const req = request(app.getHttpServer())[endpoint.method](`${API}${endpoint.path()}`)
    if (token) req.set('authorization', `Bearer ${token}`)
    return endpoint.body === undefined ? req : req.send(endpoint.body)
  }

  function get(path: string, token?: string) {
    const req = request(app.getHttpServer()).get(`${API}${path}`)
    return token ? req.set('authorization', `Bearer ${token}`) : req
  }

  const endpoints: Endpoint[] = [
    { name: 'GET /audit-log', method: 'get', path: () => '/audit-log', admitted: 200 },
    { name: 'GET /operators', method: 'get', path: () => '/operators', admitted: 200 },
    {
      name: 'GET /operators/:id',
      method: 'get',
      path: () => `/operators/${verifiedOperatorId}`,
      admitted: 200,
    },
    {
      name: 'POST /operators/:id/suspend',
      method: 'post',
      path: () => `/operators/${verifiedOperatorId}/suspend`,
      admitted: 204,
    },
    {
      name: 'POST /operators/:id/reactivate',
      method: 'post',
      path: () => `/operators/${suspendedOperatorId}/reactivate`,
      admitted: 204,
    },
    {
      name: 'POST /invites',
      method: 'post',
      path: () => '/invites',
      body: { email: 'new.operator@e2e.invalid', businessName: 'New Business' },
      admitted: 201,
    },
    {
      name: 'POST /ingestion/osm/region',
      method: 'post',
      path: () => '/ingestion/osm/region',
      body: REGION,
      admitted: 201,
    },
    {
      name: 'POST /ingestion/google/region',
      method: 'post',
      path: () => '/ingestion/google/region',
      body: REGION,
      admitted: 201,
    },
    {
      name: 'POST /ingestion/sweep',
      method: 'post',
      path: () => '/ingestion/sweep',
      body: { regions: [REGION] },
      admitted: 201,
    },
    {
      name: 'POST /ingestion/promote',
      method: 'post',
      path: () => '/ingestion/promote',
      body: {},
      admitted: 201,
    },
    {
      name: 'POST /ingestion/reclassify',
      method: 'post',
      path: () => '/ingestion/reclassify',
      body: {},
      admitted: 201,
    },
    {
      name: 'POST /ingestion/refresh',
      method: 'post',
      path: () => '/ingestion/refresh',
      body: {},
      admitted: 201,
    },
  ]

  it('covers every endpoint the refactor migrated', () => {
    expect(endpoints).toHaveLength(12)
  })

  describe.each(endpoints.map((endpoint) => [endpoint.name, endpoint] as const))(
    '%s',
    (_name, endpoint) => {
      it('still admits a platform admin', async () => {
        await call(endpoint, platformToken).expect(endpoint.admitted)
      })

      it('still refuses an operator admin', async () => {
        await call(endpoint, operatorAdminToken).expect(403)
      })

      it('still refuses operator staff and a consumer', async () => {
        await call(endpoint, operatorStaffToken).expect(403)
        await call(endpoint, consumerToken).expect(403)
      })

      it('still answers an anonymous caller 401, not 403', async () => {
        await call(endpoint).expect(401)
      })
    },
  )

  describe('routes carrying no permission decorator', () => {
    it('leaves operator-tier routes reachable by their operator roles', async () => {
      await get('/facilities', operatorStaffToken).expect(200)
      await get('/tariff-plans', operatorAdminToken).expect(200)
    })

    it('leaves a consumer-tier route reachable by a consumer', async () => {
      await get('/saved-facilities', consumerToken).expect(200)
    })

    it('leaves a public route reachable with no token at all', async () => {
      await get('/invites/not-a-real-token').expect(404)
    })
  })

  describe('operator-tier invite routes the refactor deliberately left alone', () => {
    it('still admits an operator admin alongside a platform admin', async () => {
      await get('/invites', operatorAdminToken).expect(200)
      await get('/invites', platformToken).expect(200)
    })

    it('still refuses operator staff', async () => {
      await get('/invites', operatorStaffToken).expect(403)
    })
  })
})
