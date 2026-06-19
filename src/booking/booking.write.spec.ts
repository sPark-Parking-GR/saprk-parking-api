import type { AuthUser } from '@spark/types'
import { BookingStatus } from '@prisma/client'
import { BookingService } from './booking.service'
import { OperatorScopeService, type OperatorScope } from '../common/authz/operator-scope.service'
import {
  BookingNotFoundError,
  BookingStatusTransitionError,
} from '../common/errors/domain.errors'
import type { InventoryService } from '../inventory/inventory.service'
import type { NotificationsService } from '../notifications/notifications.service'
import type { PaymentsService } from '../payments/payments.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { TariffService } from '../tariff/tariff.service'
import { listBookingsSchema } from './dto/booking.dto'

const operatorUser: AuthUser = {
  id: 'u-op',
  email: 'op@spark.gr',
  role: 'operator_staff',
  emailVerified: true,
}

const platformUser: AuthUser = {
  id: 'u-pa',
  email: 'pa@spark.gr',
  role: 'platform_admin',
  emailVerified: true,
}

describe('BookingService ops board', () => {
  let prisma: {
    booking: {
      findMany: jest.Mock
      count: jest.Mock
      findUnique: jest.Mock
      update: jest.Mock
    }
    auditLog: { create: jest.Mock }
    $transaction: jest.Mock
  }
  let tx: { booking: { findUnique: jest.Mock; update: jest.Mock }; auditLog: { create: jest.Mock } }
  let scope: { resolve: jest.Mock; scopeWhere: jest.Mock }
  let service: BookingService

  function setScope(s: OperatorScope) {
    scope.resolve.mockResolvedValue(s)
    scope.scopeWhere.mockReturnValue(s.kind === 'platform' ? {} : { operatorId: s.operatorId })
  }

  beforeEach(() => {
    tx = {
      booking: { findUnique: jest.fn(), update: jest.fn() },
      auditLog: { create: jest.fn() },
    }
    prisma = {
      booking: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    }
    scope = { resolve: jest.fn(), scopeWhere: jest.fn() }
    service = new BookingService(
      prisma as unknown as PrismaService,
      {} as unknown as TariffService,
      {} as unknown as InventoryService,
      {} as unknown as PaymentsService,
      {} as unknown as NotificationsService,
      scope as unknown as OperatorScopeService,
    )
  })

  it('operator list scopes by its own facility operator', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })

    await service.adminList(operatorUser, listBookingsSchema.parse({}))

    const where = prisma.booking.findMany.mock.calls[0]![0].where
    expect(where.facility).toEqual({ operatorId: 'op1' })
  })

  it('platform list may filter by facilityId without operator scope', async () => {
    setScope({ kind: 'platform' })

    await service.adminList(platformUser, listBookingsSchema.parse({ facilityId: 'f9' }))

    const where = prisma.booking.findMany.mock.calls[0]![0].where
    expect(where.facility).toEqual({ id: 'f9' })
    expect(where.facilityId).toBeUndefined()
  })

  it('status and q filters reach the query', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })

    await service.adminList(
      operatorUser,
      listBookingsSchema.parse({ status: 'CONFIRMED', q: 'AB12' }),
    )

    const where = prisma.booking.findMany.mock.calls[0]![0].where
    expect(where.status).toBe(BookingStatus.CONFIRMED)
    expect(where.OR).toEqual([
      { accessCode: { contains: 'AB12', mode: 'insensitive' } },
      { vehiclePlate: { contains: 'AB12', mode: 'insensitive' } },
    ])
  })

  it('check-in transitions CONFIRMED → CHECKED_IN and audits the actor', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    tx.booking.findUnique.mockResolvedValue({
      status: BookingStatus.CONFIRMED,
      facility: { operatorId: 'op1' },
    })

    await service.checkIn('b1', operatorUser)

    expect(tx.booking.update.mock.calls[0]![0].data.status).toBe(BookingStatus.CHECKED_IN)
    expect(tx.booking.update.mock.calls[0]![0].data.statusHistory.create.changedBy).toBe('u-op')
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'booking.checked_in' }) }),
    )
  })

  it('check-in on a booking of another operator returns not-found (no leak)', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    tx.booking.findUnique.mockResolvedValue({
      status: BookingStatus.CONFIRMED,
      facility: { operatorId: 'op2' },
    })

    await expect(service.checkIn('b1', operatorUser)).rejects.toBeInstanceOf(BookingNotFoundError)
    expect(tx.booking.update).not.toHaveBeenCalled()
  })

  it('check-in from a wrong status throws a transition error', async () => {
    setScope({ kind: 'operator', operatorId: 'op1' })
    tx.booking.findUnique.mockResolvedValue({
      status: BookingStatus.CHECKED_IN,
      facility: { operatorId: 'op1' },
    })

    await expect(service.checkIn('b1', operatorUser)).rejects.toBeInstanceOf(
      BookingStatusTransitionError,
    )
  })

  it('platform check-out works across any operator', async () => {
    setScope({ kind: 'platform' })
    tx.booking.findUnique.mockResolvedValue({
      status: BookingStatus.CHECKED_IN,
      facility: { operatorId: 'op-any' },
    })

    await service.checkOut('b1', platformUser)

    expect(tx.booking.update.mock.calls[0]![0].data.status).toBe(BookingStatus.CHECKED_OUT)
  })
})
