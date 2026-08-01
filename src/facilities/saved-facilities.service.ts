import { Injectable } from '@nestjs/common'
import { FacilityKind, Prisma } from '@prisma/client'
import type { AuthUser } from '@spark/types'
import { FacilityNotFoundError } from '../common/errors/domain.errors'
import { PrismaService } from '../prisma/prisma.service'

const SAVED_SELECT = {
  createdAt: true,
  facility: {
    select: {
      id: true,
      name: true,
      address: true,
      lat: true,
      lng: true,
      kind: true,
      isActive: true,
      isVerified: true,
    },
  },
} satisfies Prisma.SavedFacilitySelect

type SavedRow = Prisma.SavedFacilityGetPayload<{ select: typeof SAVED_SELECT }>

export interface SavedFacilityItem {
  facilityId: string
  name: string
  address: string
  lat: number
  lng: number
  savedAt: Date
  /** False once the facility is deactivated, unverified or reclassified RESTRICTED. */
  available: boolean
}

export interface SavedFacilityList {
  items: SavedFacilityItem[]
  total: number
}

@Injectable()
export class SavedFacilitiesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every bookmark the caller holds, archived facilities included. A facility the operator
   * later deactivates, un-verifies or reclassifies RESTRICTED stays in the list carrying
   * `available: false`: filtering it out would make the user's own data disappear over an
   * operator-side change that is routinely reversed, and resolving each row through the
   * public detail read — which throws FacilityNotFoundError for exactly those states —
   * would fail the whole list because one entry was archived.
   */
  async list(user: AuthUser): Promise<SavedFacilityList> {
    const rows = await this.prisma.savedFacility.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: SAVED_SELECT,
    })

    return { items: rows.map(toItem), total: rows.length }
  }

  /**
   * Saving is an upsert, so a double tap on the save control is not a 409 the client has
   * to interpret — the second call reports the same bookmark the first one created. Only a
   * facility the caller could have discovered may be saved, which is the same visibility
   * predicate the public detail read uses.
   */
  async add(user: AuthUser, facilityId: string): Promise<SavedFacilityItem> {
    const facility = await this.prisma.facility.findFirst({
      where: {
        id: facilityId,
        isActive: true,
        isVerified: true,
        kind: { not: FacilityKind.RESTRICTED },
      },
      select: { id: true },
    })
    if (!facility) throw new FacilityNotFoundError(facilityId)

    const saved = await this.prisma.savedFacility.upsert({
      where: { userId_facilityId: { userId: user.id, facilityId } },
      create: { userId: user.id, facilityId },
      update: {},
      select: SAVED_SELECT,
    })

    return toItem(saved)
  }

  /**
   * Scoped delete rather than a lookup-then-delete: a bookmark that is not the caller's is
   * neither found nor reported, so the endpoint cannot be used to ask who saved what, and
   * repeating the unsave stays a no-op instead of a 404 the client has to special-case.
   */
  async remove(user: AuthUser, facilityId: string): Promise<void> {
    await this.prisma.savedFacility.deleteMany({ where: { userId: user.id, facilityId } })
  }
}

function toItem(row: SavedRow): SavedFacilityItem {
  const { facility } = row
  return {
    facilityId: facility.id,
    name: facility.name,
    address: facility.address,
    lat: facility.lat.toNumber(),
    lng: facility.lng.toNumber(),
    savedAt: row.createdAt,
    available:
      facility.isActive && facility.isVerified && facility.kind !== FacilityKind.RESTRICTED,
  }
}
