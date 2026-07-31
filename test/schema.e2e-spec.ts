import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { truncateAll } from './utils/db'
import { seedFacility, seedOperator } from './utils/seed'

const MIGRATIONS_DIR = resolve(__dirname, '..', 'prisma', 'migrations')

describe('schema (e2e)', () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = new PrismaClient()
    await prisma.$connect()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await truncateAll(prisma)
  })

  it('applies every committed migration to an empty database', async () => {
    const committed = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    const applied = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name ASC`

    expect(applied.map((row) => row.migration_name)).toEqual(committed)
  })

  it('enables the postgis extension and indexes Facility.geog with GiST', async () => {
    const [extensions, index] = await Promise.all([
      prisma.$queryRaw<Array<{ extname: string }>>`
        SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'pg_trgm')`,
      prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'Facility_geog_idx'`,
    ])

    expect(extensions.map((row) => row.extname).sort()).toContain('postgis')
    expect(index[0]?.indexdef).toContain('USING gist')
  })

  it('populates the generated geog column from lat/lng on insert and on update', async () => {
    const operator = await seedOperator(prisma)
    const facility = await seedFacility(prisma, {
      operatorId: operator.id,
      lat: 37.9838,
      lng: 23.7275,
    })

    const inserted = await prisma.$queryRaw<Array<{ lat: number; lng: number }>>`
      SELECT ST_Y("geog"::geometry) AS lat, ST_X("geog"::geometry) AS lng
      FROM "Facility" WHERE id = ${facility.id}`

    expect(inserted[0]?.lat).toBeCloseTo(37.9838, 6)
    expect(inserted[0]?.lng).toBeCloseTo(23.7275, 6)

    await prisma.facility.update({
      where: { id: facility.id },
      data: { lat: 40.6401, lng: 22.9444 },
    })

    const updated = await prisma.$queryRaw<Array<{ lat: number; lng: number }>>`
      SELECT ST_Y("geog"::geometry) AS lat, ST_X("geog"::geometry) AS lng
      FROM "Facility" WHERE id = ${facility.id}`

    expect(updated[0]?.lat).toBeCloseTo(40.6401, 6)
    expect(updated[0]?.lng).toBeCloseTo(22.9444, 6)
  })
})
