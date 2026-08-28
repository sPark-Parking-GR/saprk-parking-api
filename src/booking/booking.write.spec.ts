import type { AuthUser } from '@spark/types'
import { BookingStatus, PaymentStatus, Prisma, RefundStatus } from '@prisma/client'
import { createHash } from 'crypto'
import { BookingService } from './booking.service'
import { ACCESS_CODE_LENGTH } from './credentials'
import type { OperatorScopeService, OperatorScope } from '../common/authz/operator-scope.service'
import {
  AccessCodeGenerationError,
  BookingNotFoundError,
  BookingStatusTransitionError,
  IdempotencyConflictError,
  InvalidTariffScheduleError,
  RefundFailedError,
} from '../common/errors/domain.errors'
import type { InventoryService } from '../inventory/inventory.service'
import type { NotificationsService } from '../notifications/notifications.service'
import type { PaymentsService } from '../payments/payments.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { TariffService } from '../tariff/tariff.service'
import { listBookingsSchema, listMyBookingsSchema } from './dto/booking.dto'

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
    scope.scopeWhere.mockReturnValue(
      s.kind === 'platform' ? {} : { operatorId: { in: s.operatorIds } },
    )
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
    setScope({ kind: 'operator', operatorIds: ['op1'] })

    await service.adminList(operatorUser, listBookingsSchema.parse({}))

    const where = prisma.booking.findMany.mock.calls[0]![0].where
    expect(where.facility).toEqual({ operatorId: { in: ['op1'] } })
  })

  it('platform list may filter by facilityId without operator scope', async () => {
    setScope({ kind: 'platform' })

    await service.adminList(platformUser, listBookingsSchema.parse({ facilityId: 'f9' }))

    const where = prisma.booking.findMany.mock.calls[0]![0].where
    expect(where.facility).toEqual({ id: 'f9' })
    expect(where.facilityId).toBeUndefined()
  })

  it('status and q filters reach the query', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })

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
    setScope({ kind: 'operator', operatorIds: ['op1'] })
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
    setScope({ kind: 'operator', operatorIds: ['op1'] })
    tx.booking.findUnique.mockResolvedValue({
      status: BookingStatus.CONFIRMED,
      facility: { operatorId: 'op2' },
    })

    await expect(service.checkIn('b1', operatorUser)).rejects.toBeInstanceOf(BookingNotFoundError)
    expect(tx.booking.update).not.toHaveBeenCalled()
  })

  it('multi-operator list spans every membership and excludes any other operator', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1', 'op2'] })

    await service.adminList(operatorUser, listBookingsSchema.parse({}))

    const where = prisma.booking.findMany.mock.calls[0]![0].where
    expect(where.facility).toEqual({ operatorId: { in: ['op1', 'op2'] } })
  })

  it('check-in works on a booking of the caller second operator', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1', 'op2'] })
    tx.booking.findUnique.mockResolvedValue({
      status: BookingStatus.CONFIRMED,
      facility: { operatorId: 'op2' },
    })

    await service.checkIn('b1', operatorUser)

    expect(tx.booking.update.mock.calls[0]![0].data.status).toBe(BookingStatus.CHECKED_IN)
  })

  it('check-in on a third operator booking still returns not-found for a multi-operator user', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1', 'op2'] })
    tx.booking.findUnique.mockResolvedValue({
      status: BookingStatus.CONFIRMED,
      facility: { operatorId: 'op3' },
    })

    await expect(service.checkIn('b1', operatorUser)).rejects.toBeInstanceOf(BookingNotFoundError)
    expect(tx.booking.update).not.toHaveBeenCalled()
  })

  it('check-in from a wrong status throws a transition error', async () => {
    setScope({ kind: 'operator', operatorIds: ['op1'] })
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
    // No plan pin, so this stays a pure transition test; repricing has its own suite.
    prisma.booking.findUnique.mockResolvedValue({
      id: 'b1',
      status: BookingStatus.CHECKED_IN,
      startsAt: new Date(Date.now() - 3_600_000),
      quotedPriceCents: 500,
      currency: 'EUR',
      tariffPlanId: null,
      tariffPlanVersion: null,
      facility: { operatorId: 'op-any' },
    })
    tx.booking.findUnique.mockResolvedValue({ status: BookingStatus.CHECKED_IN })

    await service.checkOut('b1', platformUser)

    expect(tx.booking.update.mock.calls[0]![0].data.status).toBe(BookingStatus.CHECKED_OUT)
  })

  describe('consumer trips', () => {
    const consumer: AuthUser = {
      id: 'u-consumer',
      email: 'consumer@spark.gr',
      role: 'user',
      emailVerified: true,
    }

    it('filters on the authenticated caller and resolves no operator scope at all', async () => {
      await service.listMine(consumer, listMyBookingsSchema.parse({}))

      const args = prisma.booking.findMany.mock.calls[0]![0]
      expect(args.where).toEqual({ userId: 'u-consumer' })
      expect(args.orderBy).toEqual({ startsAt: 'desc' })
      expect(scope.resolve).not.toHaveBeenCalled()
    })

    it('counts the same predicate it lists, so the page total cannot span other users', async () => {
      await service.listMine(consumer, listMyBookingsSchema.parse({ status: 'CONFIRMED' }))

      expect(prisma.booking.count.mock.calls[0]![0].where).toEqual(
        prisma.booking.findMany.mock.calls[0]![0].where,
      )
    })

    it('never selects qrSecret', async () => {
      await service.listMine(consumer, listMyBookingsSchema.parse({}))

      expect(prisma.booking.findMany.mock.calls[0]![0].select).not.toHaveProperty('qrSecret')
    })

    it('applies the requested page window', async () => {
      await service.listMine(consumer, listMyBookingsSchema.parse({ skip: '10', take: '5' }))

      const args = prisma.booking.findMany.mock.calls[0]![0]
      expect(args.skip).toBe(10)
      expect(args.take).toBe(5)
    })
  })
})

const owner: AuthUser = {
  id: 'u-owner',
  email: 'owner@spark.gr',
  role: 'user',
  emailVerified: true,
}

const stranger: AuthUser = {
  id: 'u-stranger',
  email: 'stranger@spark.gr',
  role: 'user',
  emailVerified: true,
}

describe('BookingService consumer ownership', () => {
  let prisma: {
    booking: { findUnique: jest.Mock; update: jest.Mock }
    payment: { findUnique: jest.Mock; update: jest.Mock }
    auditLog: { create: jest.Mock }
    $transaction: jest.Mock
  }
  let tx: {
    booking: { findUnique: jest.Mock; update: jest.Mock }
    payment: { update: jest.Mock }
    refund: { create: jest.Mock; update: jest.Mock }
    auditLog: { create: jest.Mock }
  }
  let payments: { capturePayment: jest.Mock; refund: jest.Mock }
  let notifications: { sendBookingConfirmation: jest.Mock; sendBookingCancellation: jest.Mock }
  let scope: { resolve: jest.Mock; scopeWhere: jest.Mock }
  let service: BookingService

  // What assertBookingAccess reads: the owner plus the operator holding the facility.
  const accessRow = (userId: string, operatorId = 'op1') => ({
    userId,
    facility: { operatorId },
  })

  const fullRow = {
    id: 'b1',
    accessCode: 'CODE1234',
    status: BookingStatus.CONFIRMED,
    facility: { id: 'f1', name: 'Lot A', address: 'addr' },
    statusHistory: [],
  }

  beforeEach(() => {
    tx = {
      booking: { findUnique: jest.fn(), update: jest.fn() },
      payment: { update: jest.fn() },
      refund: { create: jest.fn(), update: jest.fn() },
      auditLog: { create: jest.fn() },
    }
    prisma = {
      booking: { findUnique: jest.fn(), update: jest.fn() },
      payment: { findUnique: jest.fn().mockResolvedValue({ bookingId: 'b1' }), update: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    }
    payments = {
      capturePayment: jest.fn().mockResolvedValue({ status: 'succeeded' }),
      refund: jest
        .fn()
        .mockResolvedValue({ providerRefundId: 'r1', status: 'succeeded', amountCents: 500 }),
    }
    notifications = {
      sendBookingConfirmation: jest.fn(),
      sendBookingCancellation: jest.fn(),
    }
    scope = { resolve: jest.fn(), scopeWhere: jest.fn() }
    service = new BookingService(
      prisma as unknown as PrismaService,
      {} as unknown as TariffService,
      {} as unknown as InventoryService,
      payments as unknown as PaymentsService,
      notifications as unknown as NotificationsService,
      scope as unknown as OperatorScopeService,
    )
  })

  describe('getBooking', () => {
    it('returns the record to its owner', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce(accessRow(owner.id))
        .mockResolvedValueOnce(fullRow)

      await expect(service.getBooking('b1', owner)).resolves.toBe(fullRow)
    })

    it('hides another consumer booking as not-found and never loads the record', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(accessRow(owner.id))

      await expect(service.getBooking('b1', stranger)).rejects.toBeInstanceOf(BookingNotFoundError)
      // One read only: the access check refused before anything sensitive was fetched.
      expect(prisma.booking.findUnique).toHaveBeenCalledTimes(1)
    })

    it('never resolves operator scope for a consumer, so no 403 can leak existence', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(accessRow(owner.id))

      await expect(service.getBooking('b1', stranger)).rejects.toBeInstanceOf(BookingNotFoundError)
      expect(scope.resolve).not.toHaveBeenCalled()
    })

    it('makes a foreign booking indistinguishable from a nonexistent one', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(accessRow(owner.id))
      const foreign = await service.getBooking('b1', stranger).catch((e: Error) => e)

      prisma.booking.findUnique.mockResolvedValueOnce(null)
      const missing = await service.getBooking('b1', stranger).catch((e: Error) => e)

      expect((foreign as Error).constructor).toBe((missing as Error).constructor)
      expect((foreign as Error).message).toBe((missing as Error).message)
    })

    it('lets operator staff scoped to the facility read it', async () => {
      scope.resolve.mockResolvedValue({ kind: 'operator', operatorIds: ['op1', 'op2'] })
      prisma.booking.findUnique
        .mockResolvedValueOnce(accessRow(owner.id, 'op2'))
        .mockResolvedValueOnce(fullRow)

      await expect(service.getBooking('b1', operatorUser)).resolves.toBe(fullRow)
    })

    it('hides a booking held by an operator the staff does not belong to', async () => {
      scope.resolve.mockResolvedValue({ kind: 'operator', operatorIds: ['op1'] })
      prisma.booking.findUnique.mockResolvedValueOnce(accessRow(owner.id, 'op-other'))

      await expect(service.getBooking('b1', operatorUser)).rejects.toBeInstanceOf(
        BookingNotFoundError,
      )
    })

    it('lets a platform admin read any booking', async () => {
      scope.resolve.mockResolvedValue({ kind: 'platform' })
      prisma.booking.findUnique
        .mockResolvedValueOnce(accessRow(owner.id, 'op-any'))
        .mockResolvedValueOnce(fullRow)

      await expect(service.getBooking('b1', platformUser)).resolves.toBe(fullRow)
    })

    it('never selects qrSecret, and selects only the intended user/payment/refund fields', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce(accessRow(owner.id))
        .mockResolvedValueOnce(fullRow)

      await service.getBooking('b1', owner)

      const select = prisma.booking.findUnique.mock.calls[1]![0].select
      expect(Object.keys(select)).not.toContain('qrSecret')
      expect(select.accessCode).toBe(true)
      expect(select.user).toEqual({ select: { email: true, displayName: true } })
      expect(select.payment).toEqual({
        select: {
          status: true,
          amountCents: true,
          currency: true,
          provider: true,
          createdAt: true,
        },
      })
      expect(select.refund).toEqual({
        select: { status: true, amountCents: true, reason: true, createdAt: true },
      })
    })

    it('returns the enriched user, payment and refund relations to the owner', async () => {
      const enrichedRow = {
        ...fullRow,
        user: { email: owner.email, displayName: 'Owner Name' },
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 500,
          currency: 'EUR',
          provider: 'stripe',
          createdAt: new Date('2026-08-01T09:00:00Z'),
        },
        refund: {
          status: RefundStatus.SUCCEEDED,
          amountCents: 500,
          reason: 'booking_cancelled',
          createdAt: new Date('2026-08-01T10:00:00Z'),
        },
      }
      prisma.booking.findUnique
        .mockResolvedValueOnce(accessRow(owner.id))
        .mockResolvedValueOnce(enrichedRow)

      await expect(service.getBooking('b1', owner)).resolves.toBe(enrichedRow)
    })

    it('gives operator staff the same enriched shape as the owner', async () => {
      scope.resolve.mockResolvedValue({ kind: 'operator', operatorIds: ['op2'] })
      prisma.booking.findUnique
        .mockResolvedValueOnce(accessRow(owner.id, 'op2'))
        .mockResolvedValueOnce(fullRow)

      await service.getBooking('b1', operatorUser)

      const select = prisma.booking.findUnique.mock.calls[1]![0].select
      expect(select.user).toEqual({ select: { email: true, displayName: true } })
      expect(select.payment).toBeDefined()
      expect(select.refund).toBeDefined()
    })
  })

  describe('cancelBooking', () => {
    const cancellable = {
      id: 'b1',
      status: BookingStatus.CONFIRMED,
      currency: 'EUR',
      accessCode: 'CODE1234',
      startsAt: new Date('2026-08-01T10:00:00Z'),
      endsAt: new Date('2026-08-01T12:00:00Z'),
      quotedPriceCents: 500,
      facility: { name: 'Lot A' },
      user: { email: 'owner@spark.gr' },
      payment: {
        id: 'p1',
        providerPaymentId: 'pi_1',
        amountCents: 500,
        status: PaymentStatus.SUCCEEDED,
      },
    }

    it('refuses a stranger with not-found and issues no refund', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(accessRow(owner.id))

      await expect(service.cancelBooking('b1', stranger)).rejects.toBeInstanceOf(
        BookingNotFoundError,
      )
      expect(payments.refund).not.toHaveBeenCalled()
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('records the refund intent BEFORE calling the provider', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce(accessRow(owner.id))
        .mockResolvedValueOnce(cancellable)
      tx.booking.findUnique
        .mockResolvedValueOnce({ status: BookingStatus.CONFIRMED })
        .mockResolvedValueOnce({ status: BookingStatus.REFUND_PENDING })

      await service.cancelBooking('b1', owner)

      const intentOrder = tx.refund.create.mock.invocationCallOrder[0]!
      const providerOrder = payments.refund.mock.invocationCallOrder[0]!
      expect(intentOrder).toBeLessThan(providerOrder)
      expect(tx.refund.create.mock.calls[0]![0].data.status).toBe(RefundStatus.PENDING)
      expect(tx.booking.update.mock.calls[0]![0].data.status).toBe(BookingStatus.REFUND_PENDING)
    })

    it('cancels and refunds for the owner, notifying the account email', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce(accessRow(owner.id))
        .mockResolvedValueOnce(cancellable)
      tx.booking.findUnique
        .mockResolvedValueOnce({ status: BookingStatus.CONFIRMED })
        .mockResolvedValueOnce({ status: BookingStatus.REFUND_PENDING })

      await service.cancelBooking('b1', owner)

      expect(payments.refund).toHaveBeenCalledTimes(1)
      expect(payments.refund.mock.calls[0]![0].idempotencyKey).toBe('ref_b1')
      expect(tx.refund.update).toHaveBeenCalledWith({
        where: { bookingId: 'b1' },
        data: { status: RefundStatus.SUCCEEDED, providerRefundId: 'r1' },
      })
      expect(tx.payment.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { status: PaymentStatus.REFUNDED },
      })
      const lastBookingUpdate = tx.booking.update.mock.calls.at(-1)![0]
      expect(lastBookingUpdate.data.status).toBe(BookingStatus.REFUNDED)
      expect(lastBookingUpdate.data.statusHistory.create.changedBy).toBe(owner.id)
      expect(notifications.sendBookingCancellation.mock.calls[0]![0].recipientEmail).toBe(
        'owner@spark.gr',
      )
    })

    it('a provider failure leaves REFUND_PENDING plus a FAILED refund row, not a silent success', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce(accessRow(owner.id))
        .mockResolvedValueOnce(cancellable)
      tx.booking.findUnique.mockResolvedValueOnce({ status: BookingStatus.CONFIRMED })
      payments.refund.mockRejectedValueOnce(new Error('provider down'))

      await expect(service.cancelBooking('b1', owner)).rejects.toBeInstanceOf(RefundFailedError)

      expect(tx.booking.update).toHaveBeenCalledTimes(1)
      expect(tx.booking.update.mock.calls[0]![0].data.status).toBe(BookingStatus.REFUND_PENDING)
      expect(tx.refund.update).toHaveBeenCalledWith({
        where: { bookingId: 'b1' },
        data: { status: RefundStatus.FAILED },
      })
      expect(notifications.sendBookingCancellation).not.toHaveBeenCalled()
    })

    it('a refund the provider reports as failed is recorded the same way', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce(accessRow(owner.id))
        .mockResolvedValueOnce(cancellable)
      tx.booking.findUnique.mockResolvedValueOnce({ status: BookingStatus.CONFIRMED })
      payments.refund.mockResolvedValueOnce({
        providerRefundId: 'r1',
        status: 'failed',
        amountCents: 500,
      })

      await expect(service.cancelBooking('b1', owner)).rejects.toBeInstanceOf(RefundFailedError)
      expect(tx.refund.update).toHaveBeenCalledWith({
        where: { bookingId: 'b1' },
        data: { status: RefundStatus.FAILED },
      })
    })

    it('resumes a REFUND_PENDING booking: retries the provider without a second intent row', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(accessRow(owner.id)).mockResolvedValueOnce({
        ...cancellable,
        status: BookingStatus.REFUND_PENDING,
      })
      tx.booking.findUnique.mockResolvedValueOnce({ status: BookingStatus.REFUND_PENDING })

      await service.cancelBooking('b1', owner)

      expect(tx.refund.create).not.toHaveBeenCalled()
      expect(payments.refund).toHaveBeenCalledTimes(1)
      expect(tx.refund.update).toHaveBeenCalledWith({
        where: { bookingId: 'b1' },
        data: { status: RefundStatus.SUCCEEDED, providerRefundId: 'r1' },
      })
      expect(tx.booking.update.mock.calls.at(-1)![0].data.status).toBe(BookingStatus.REFUNDED)
    })

    it('a provider-pending refund keeps the in-flight marker for the webhook to settle', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce(accessRow(owner.id))
        .mockResolvedValueOnce(cancellable)
      tx.booking.findUnique.mockResolvedValueOnce({ status: BookingStatus.CONFIRMED })
      payments.refund.mockResolvedValueOnce({
        providerRefundId: 'r1',
        status: 'pending',
        amountCents: 500,
      })

      await service.cancelBooking('b1', owner)

      expect(tx.refund.update).toHaveBeenCalledWith({
        where: { bookingId: 'b1' },
        data: { providerRefundId: 'r1' },
      })
      expect(tx.payment.update).not.toHaveBeenCalled()
      expect(tx.booking.update).toHaveBeenCalledTimes(1)
      expect(tx.booking.update.mock.calls[0]![0].data.status).toBe(BookingStatus.REFUND_PENDING)
    })
  })

  describe('confirmBooking', () => {
    const pending = {
      id: 'b1',
      status: BookingStatus.PENDING_PAYMENT,
      expiresAt: new Date(Date.now() + 60_000),
      accessCode: 'CODE1234',
      startsAt: new Date('2026-08-01T10:00:00Z'),
      endsAt: new Date('2026-08-01T12:00:00Z'),
      quotedPriceCents: 500,
      finalPriceCents: null,
      currency: 'EUR',
      userId: 'u-owner',
      facility: { name: 'Lot A' },
      user: { email: 'owner@spark.gr' },
      payment: { id: 'p1', providerPaymentId: 'pi_1' },
    }

    it('refuses a stranger with not-found and never captures payment', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(accessRow(owner.id))

      await expect(service.confirmBooking('b1', stranger)).rejects.toBeInstanceOf(
        BookingNotFoundError,
      )
      expect(payments.capturePayment).not.toHaveBeenCalled()
    })

    it('captures and confirms for the owner, notifying the account email', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce(accessRow(owner.id))
        .mockResolvedValueOnce(pending)
      tx.booking.findUnique.mockResolvedValue({ status: BookingStatus.PENDING_PAYMENT })

      const result = await service.confirmBooking('b1', owner)

      expect(payments.capturePayment).toHaveBeenCalledTimes(1)
      expect(result.status).toBe('CONFIRMED')
      expect(notifications.sendBookingConfirmation.mock.calls[0]![0].recipientEmail).toBe(
        'owner@spark.gr',
      )
    })

    describe('qr credential', () => {
      // Confirms the SAME accessCode twice. A derived credential (the old
      // sha256(accessCode)) would produce identical secrets; an independent one cannot.
      async function confirmTwiceOnTheSameCode(): Promise<string[]> {
        const secrets: string[] = []
        for (let i = 0; i < 2; i++) {
          prisma.booking.findUnique
            .mockResolvedValueOnce(accessRow(owner.id))
            .mockResolvedValueOnce(pending)
          tx.booking.findUnique.mockResolvedValue({ status: BookingStatus.PENDING_PAYMENT })
          await service.confirmBooking('b1', owner)
          secrets.push(tx.booking.update.mock.calls.at(-1)![0].data.qrSecret as string)
        }
        return secrets
      }

      it('mints a distinct secret per confirm even for an identical access code', async () => {
        const [first, second] = await confirmTwiceOnTheSameCode()

        expect(first).toEqual(expect.any(String))
        expect(first).not.toBe(second)
      })

      it('is not derived from the access code by any obvious transform', async () => {
        const [secret] = await confirmTwiceOnTheSameCode()
        const code = pending.accessCode

        expect(secret).not.toBe(code)
        expect(secret).not.toContain(code)
        for (const algorithm of ['sha256', 'sha1', 'md5']) {
          expect(secret).not.toBe(createHash(algorithm).update(code).digest('hex'))
          expect(secret).not.toBe(createHash(algorithm).update(code).digest('base64url'))
        }
      })

      it('no longer writes the reversible qrTokenHash column', async () => {
        await confirmTwiceOnTheSameCode()

        expect(tx.booking.update.mock.calls.at(-1)![0].data).not.toHaveProperty('qrTokenHash')
      })
    })
  })
})

describe('BookingService check-out repricing', () => {
  const HOUR = 3_600_000
  const PLAN_ID = 'plan1'
  const PINNED_VERSION = 3

  let prisma: {
    booking: { findUnique: jest.Mock }
    $transaction: jest.Mock
  }
  let tx: { booking: { findUnique: jest.Mock; update: jest.Mock }; auditLog: { create: jest.Mock } }
  let payments: { capturePayment: jest.Mock; refund: jest.Mock; createPaymentIntent: jest.Mock }
  let scope: { resolve: jest.Mock; scopeWhere: jest.Mock }

  // Stands in for TariffService.priceWithPinnedPlan: prices at a flat hourly rate, but
  // only for the exact plan revision asked for. `livePlanVersion` is what the operator's
  // plan is at now — an edit bumps it and the old schedule ceases to exist, which is why
  // a stale pin resolves to null rather than to a price at today's rates.
  function makeService(livePlanVersion: number, centsPerHour: number) {
    const tariff = {
      priceWithPinnedPlan: jest.fn(
        async (req: { planId: string; planVersion: number; startsAt: Date; endsAt: Date }) => {
          if (req.planId !== PLAN_ID || req.planVersion !== livePlanVersion) return null
          // Floored so the milliseconds between building the fixture and the service
          // reading the clock cannot tip a whole-hour stay into the next hour.
          const hours = Math.max(
            1,
            Math.floor((req.endsAt.getTime() - req.startsAt.getTime()) / HOUR),
          )
          return { totalCents: hours * centsPerHour, currency: 'EUR', billableMinutes: hours * 60 }
        },
      ),
    }
    const service = new BookingService(
      prisma as unknown as PrismaService,
      tariff as unknown as TariffService,
      {} as unknown as InventoryService,
      payments as unknown as PaymentsService,
      {} as unknown as NotificationsService,
      scope as unknown as OperatorScopeService,
    )
    return { service, tariff }
  }

  // Booked 2h at 250/h = 500 cents, currently checked in.
  function checkedInBooking(hoursAgo: number, over: Record<string, unknown> = {}) {
    return {
      id: 'b1',
      status: BookingStatus.CHECKED_IN,
      startsAt: new Date(Date.now() - hoursAgo * HOUR),
      quotedPriceCents: 500,
      currency: 'EUR',
      tariffPlanId: PLAN_ID,
      tariffPlanVersion: PINNED_VERSION,
      facility: { operatorId: 'op1' },
      ...over,
    }
  }

  const lastUpdate = () => tx.booking.update.mock.calls.at(-1)![0].data
  const lastAudit = () => tx.auditLog.create.mock.calls.at(-1)![0].data

  beforeEach(() => {
    tx = {
      booking: { findUnique: jest.fn(), update: jest.fn() },
      auditLog: { create: jest.fn() },
    }
    prisma = {
      booking: { findUnique: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    }
    payments = { capturePayment: jest.fn(), refund: jest.fn(), createPaymentIntent: jest.fn() }
    scope = { resolve: jest.fn().mockResolvedValue({ kind: 'platform' }), scopeWhere: jest.fn() }
    tx.booking.findUnique.mockResolvedValue({ status: BookingStatus.CHECKED_IN })
  })

  it('bills a short stay below the quote and records the negative delta', async () => {
    prisma.booking.findUnique.mockResolvedValue(checkedInBooking(1))
    const { service } = makeService(PINNED_VERSION, 250)

    await service.checkOut('b1', platformUser)

    const data = lastUpdate()
    expect(data.status).toBe(BookingStatus.CHECKED_OUT)
    expect(data.finalPriceCents).toBe(250)
    expect(data.finalPriceCents).toBeLessThan(500)
    expect(data.priceAdjustmentCents).toBe(-250)
    expect(lastAudit().payload).toMatchObject({ outcome: 'repriced', adjustmentCents: -250 })
  })

  it('bills an overstay above the quote and records the positive delta', async () => {
    prisma.booking.findUnique.mockResolvedValue(checkedInBooking(5))
    const { service } = makeService(PINNED_VERSION, 250)

    await service.checkOut('b1', platformUser)

    expect(lastUpdate().finalPriceCents).toBe(1250)
    expect(lastUpdate().priceAdjustmentCents).toBe(750)
  })

  it('records the delta without moving any money', async () => {
    prisma.booking.findUnique.mockResolvedValue(checkedInBooking(5))
    const { service } = makeService(PINNED_VERSION, 250)

    await service.checkOut('b1', platformUser)

    expect(payments.createPaymentIntent).not.toHaveBeenCalled()
    expect(payments.capturePayment).not.toHaveBeenCalled()
    expect(payments.refund).not.toHaveBeenCalled()
  })

  it('reprices against the PINNED plan revision, not the current one', async () => {
    prisma.booking.findUnique.mockResolvedValue(checkedInBooking(5))
    const { service, tariff } = makeService(PINNED_VERSION, 250)

    await service.checkOut('b1', platformUser)

    expect(tariff.priceWithPinnedPlan.mock.calls[0]![0]).toMatchObject({
      planId: PLAN_ID,
      planVersion: PINNED_VERSION,
    })
  })

  it('keeps the agreed price when the plan was edited after the booking', async () => {
    prisma.booking.findUnique.mockResolvedValue(checkedInBooking(5))
    // The operator doubled the rate and bumped the plan to v4 mid-stay. The v3 schedule
    // that produced the quote no longer exists, so the price the customer agreed to holds.
    const { service } = makeService(PINNED_VERSION + 1, 500)

    await service.checkOut('b1', platformUser)

    const data = lastUpdate()
    expect(data.finalPriceCents).toBe(500)
    expect(data.priceAdjustmentCents).toBeNull()
    expect(lastAudit().payload.outcome).toBe('plan_version_changed')
  })

  it('still opens the barrier when repricing throws, keeping the quote', async () => {
    prisma.booking.findUnique.mockResolvedValue(checkedInBooking(5))
    const { service, tariff } = makeService(PINNED_VERSION, 250)
    tariff.priceWithPinnedPlan.mockRejectedValue(
      new InvalidTariffScheduleError('stay span exceeds the maximum priceable duration'),
    )

    await service.checkOut('b1', platformUser)

    expect(lastUpdate().status).toBe(BookingStatus.CHECKED_OUT)
    expect(lastUpdate().finalPriceCents).toBe(500)
    expect(lastAudit().payload.outcome).toBe('reprice_failed')
  })

  it('keeps the quote for a legacy booking with no plan pin', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      checkedInBooking(5, { tariffPlanId: null, tariffPlanVersion: null }),
    )
    const { service, tariff } = makeService(PINNED_VERSION, 250)

    await service.checkOut('b1', platformUser)

    expect(tariff.priceWithPinnedPlan).not.toHaveBeenCalled()
    expect(lastUpdate().finalPriceCents).toBe(500)
    expect(lastAudit().payload.outcome).toBe('not_pinned')
  })

  it('refuses a booking that is not checked in', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      checkedInBooking(1, { status: BookingStatus.CONFIRMED }),
    )
    const { service } = makeService(PINNED_VERSION, 250)

    await expect(service.checkOut('b1', platformUser)).rejects.toBeInstanceOf(
      BookingStatusTransitionError,
    )
    expect(tx.booking.update).not.toHaveBeenCalled()
  })

  it('hides another operator booking as not-found rather than repricing it', async () => {
    scope.resolve.mockResolvedValue({ kind: 'operator', operatorIds: ['op2'] })
    prisma.booking.findUnique.mockResolvedValue(checkedInBooking(1))
    const { service, tariff } = makeService(PINNED_VERSION, 250)

    await expect(service.checkOut('b1', operatorUser)).rejects.toBeInstanceOf(BookingNotFoundError)
    expect(tariff.priceWithPinnedPlan).not.toHaveBeenCalled()
    expect(tx.booking.update).not.toHaveBeenCalled()
  })
})

describe('BookingService createBooking idempotency', () => {
  const request = {
    facilityId: 'f1',
    startsAt: new Date('2026-08-01T10:00:00Z'),
    endsAt: new Date('2026-08-01T12:00:00Z'),
    vehicleType: 'CAR' as const,
    vehiclePlate: 'ABC123',
    idempotencyKey: 'idem-1',
    userId: owner.id,
    sourceChannel: 'WEB' as const,
  }

  const existingPending = {
    id: 'b1',
    accessCode: 'CODE1234',
    status: BookingStatus.PENDING_PAYMENT,
    expiresAt: new Date(Date.now() + 60_000),
    quotedPriceCents: 500,
    currency: 'EUR',
    payment: { providerPaymentId: 'pi_provider_1' },
  }

  let prisma: {
    booking: { findUnique: jest.Mock }
    payment: { create: jest.Mock; upsert: jest.Mock }
    auditLog: { create: jest.Mock }
  }
  let tariff: { computeQuote: jest.Mock }
  let inventory: { holdSlot: jest.Mock }
  let payments: { createPaymentIntent: jest.Mock; providerName: string }
  let service: BookingService

  beforeEach(() => {
    prisma = {
      booking: { findUnique: jest.fn() },
      payment: { create: jest.fn(), upsert: jest.fn() },
      auditLog: { create: jest.fn() },
    }
    tariff = {
      computeQuote: jest.fn().mockResolvedValue({
        totalCents: 500,
        currency: 'EUR',
        expiresAt: new Date(Date.now() + 60_000),
        planId: 'plan1',
        planVersion: 7,
      }),
    }
    inventory = { holdSlot: jest.fn() }
    payments = {
      createPaymentIntent: jest.fn().mockResolvedValue({
        providerPaymentId: 'pi_provider_1',
        clientSecret: 'secret_1',
        status: 'requires_payment',
        amountCents: 500,
        currency: 'EUR',
      }),
      providerName: 'mock',
    }
    service = new BookingService(
      prisma as unknown as PrismaService,
      tariff as unknown as TariffService,
      inventory as unknown as InventoryService,
      payments as unknown as PaymentsService,
      {} as unknown as NotificationsService,
      {} as unknown as OperatorScopeService,
    )
  })

  it('a replayed create returns a usable clientSecret via the provider idempotent replay', async () => {
    prisma.booking.findUnique.mockResolvedValue(existingPending)

    const result = await service.createBooking(request)

    expect(result.alreadyExisted).toBe(true)
    expect(result.clientSecret).toBe('secret_1')
    expect(payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'pi_b1' }),
    )
    expect(inventory.holdSlot).not.toHaveBeenCalled()
  })

  it('a replay of a booking past payment returns no secret and never calls the provider', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      ...existingPending,
      status: BookingStatus.CONFIRMED,
    })

    const result = await service.createBooking(request)

    expect(result.alreadyExisted).toBe(true)
    expect(result.clientSecret).toBeUndefined()
    expect(payments.createPaymentIntent).not.toHaveBeenCalled()
  })

  it('refuses to hand out a secret for an intent the payment row does not track', async () => {
    prisma.booking.findUnique.mockResolvedValue(existingPending)
    payments.createPaymentIntent.mockResolvedValue({
      providerPaymentId: 'pi_other',
      clientSecret: 'foreign_secret',
      status: 'requires_payment',
      amountCents: 500,
      currency: 'EUR',
    })

    const result = await service.createBooking(request)

    expect(result.clientSecret).toBeUndefined()
  })

  it('heals a missing payment row on replay so the booking can still be confirmed', async () => {
    prisma.booking.findUnique.mockResolvedValue({ ...existingPending, payment: null })

    const result = await service.createBooking(request)

    expect(result.clientSecret).toBe('secret_1')
    expect(prisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: 'b1' },
        create: expect.objectContaining({
          providerPaymentId: 'pi_provider_1',
          status: PaymentStatus.PENDING,
        }),
      }),
    )
  })

  it('maps the unique-key race between concurrent creates to a 409 conflict, not a 500', async () => {
    prisma.booking.findUnique.mockResolvedValue(null)
    inventory.holdSlot.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique violation', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['idempotencyKey'] },
      }),
    )

    await expect(service.createBooking(request)).rejects.toBeInstanceOf(IdempotencyConflictError)
    expect(prisma.payment.create).not.toHaveBeenCalled()
  })

  it('rethrows a P2002 on any other column untouched', async () => {
    prisma.booking.findUnique.mockResolvedValue(null)
    inventory.holdSlot.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique violation', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['vehicleId'] },
      }),
    )

    await expect(service.createBooking(request)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    )
  })

  it('pins the plan revision the quote priced onto the hold', async () => {
    prisma.booking.findUnique.mockResolvedValue(null)
    inventory.holdSlot.mockResolvedValue({ bookingId: 'b1', expiresAt: new Date() })

    await service.createBooking(request)

    const held = inventory.holdSlot.mock.calls[0]![0]
    expect(held.tariffPlanId).toBe('plan1')
    expect(held.tariffPlanVersion).toBe(7)
  })

  /**
   * The quote already subtracted this from totalCents; carrying it onto the hold is the only
   * thing that makes a rider's saving answerable later. Without it the figure exists for the
   * duration of one HTTP request and is then gone.
   */
  it('carries the discount the quote applied onto the hold', async () => {
    prisma.booking.findUnique.mockResolvedValue(null)
    tariff.computeQuote.mockResolvedValue({
      totalCents: 450,
      discountCents: 50,
      currency: 'EUR',
      expiresAt: new Date(Date.now() + 60_000),
      planId: 'plan1',
      planVersion: 7,
    })
    inventory.holdSlot.mockResolvedValue({ bookingId: 'b1', expiresAt: new Date() })

    await service.createBooking(request)

    expect(inventory.holdSlot.mock.calls[0]![0].discountCents).toBe(50)
  })

  describe('access code', () => {
    const codeOf = () => inventory.holdSlot.mock.calls.at(-1)![0].accessCode as string

    beforeEach(() => {
      prisma.booking.findUnique.mockResolvedValue(null)
      inventory.holdSlot.mockResolvedValue({ bookingId: 'b1', expiresAt: new Date() })
    })

    it('uses only the unambiguous base32 alphabet, at the intended length', async () => {
      for (let i = 0; i < 50; i++) {
        await service.createBooking({ ...request, idempotencyKey: `idem-${i}` })
        const code = codeOf()
        expect(code).toHaveLength(ACCESS_CODE_LENGTH)
        expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/)
      }
    })

    it('never emits the characters that get misheard when dictated', async () => {
      const codes: string[] = []
      for (let i = 0; i < 50; i++) {
        await service.createBooking({ ...request, idempotencyKey: `idem-${i}` })
        codes.push(codeOf())
      }

      expect(codes.join('')).not.toMatch(/[ILOU]/)
      // 128 bits of entropy: 50 draws colliding would mean the generator is not random.
      expect(new Set(codes).size).toBe(codes.length)
    })

    it('retries with a fresh code on collision instead of surfacing P2002', async () => {
      inventory.holdSlot.mockReset()
      inventory.holdSlot
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('unique violation', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['accessCode'] },
          }),
        )
        .mockResolvedValueOnce({ bookingId: 'b1', expiresAt: new Date() })

      const result = await service.createBooking(request)

      expect(inventory.holdSlot).toHaveBeenCalledTimes(2)
      const first = inventory.holdSlot.mock.calls[0]![0].accessCode
      const second = inventory.holdSlot.mock.calls[1]![0].accessCode
      expect(second).not.toBe(first)
      expect(result.accessCode).toBe(second)
    })

    it('gives up as a transient domain error, never a raw P2002, after exhausting retries', async () => {
      inventory.holdSlot.mockReset()
      inventory.holdSlot.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique violation', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['accessCode'] },
        }),
      )

      await expect(service.createBooking(request)).rejects.toBeInstanceOf(AccessCodeGenerationError)
      expect(inventory.holdSlot).toHaveBeenCalledTimes(5)
    })
  })
})
