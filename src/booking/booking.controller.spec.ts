import { BadRequestException } from '@nestjs/common'
import type { AuthUser } from '@spark/types'
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator'
import { ROLES_KEY } from '../auth/decorators/roles.decorator'
import { BookingController } from './booking.controller'
import type { BookingService } from './booking.service'
import type { TicketService } from './ticket.service'
import { createBookingSchema, listMyBookingsSchema } from './dto/booking.dto'

const consumer: AuthUser = {
  id: 'u-owner',
  email: 'owner@spark.gr',
  role: 'user',
  emailVerified: true,
}

type Handler =
  | 'create'
  | 'get'
  | 'cancel'
  | 'confirm'
  | 'list'
  | 'checkIn'
  | 'checkOut'
  | 'mine'
  | 'qr'
  | 'verifyTicket'

const handler = (name: Handler) => BookingController.prototype[name]

describe('BookingController authentication boundary', () => {
  let bookings: {
    createBooking: jest.Mock
    getBooking: jest.Mock
    cancelBooking: jest.Mock
    confirmBooking: jest.Mock
    listMine: jest.Mock
  }
  let tickets: { verify: jest.Mock; issue: jest.Mock }
  let controller: BookingController

  beforeEach(() => {
    bookings = {
      createBooking: jest.fn().mockResolvedValue({ bookingId: 'b1' }),
      getBooking: jest.fn(),
      cancelBooking: jest.fn(),
      confirmBooking: jest.fn(),
      listMine: jest.fn(),
    }
    tickets = { verify: jest.fn(), issue: jest.fn() }
    controller = new BookingController(
      bookings as unknown as BookingService,
      tickets as unknown as TicketService,
    )
  })

  it.each<Handler>(['create', 'get', 'cancel', 'confirm', 'mine', 'qr', 'verifyTicket'])(
    '%s is not public, so an anonymous caller is rejected by the auth guard',
    (name) => {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler(name))).toBeUndefined()
    },
  )

  it.each<Handler>(['create', 'get', 'cancel', 'confirm', 'mine', 'qr'])(
    '%s requires an account role, closing it to the guest role too',
    (name) => {
      expect(Reflect.getMetadata(ROLES_KEY, handler(name))).toEqual([
        'user',
        'operator_staff',
        'operator_admin',
        'platform_admin',
      ])
    },
  )

  it('verify-qr is operator staff only, so a consumer cannot scan tickets', () => {
    expect(Reflect.getMetadata(ROLES_KEY, handler('verifyTicket'))).toEqual([
      'operator_staff',
      'operator_admin',
    ])
  })

  it('creates the booking against the authenticated caller, not anything in the body', async () => {
    const startsAt = new Date(Date.now() + 60_000)
    const body = createBookingSchema.parse({
      facilityId: 'f1',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      vehicleType: 'CAR',
      vehiclePlate: 'ABC123',
      sourceChannel: 'MOBILE',
      userId: 'u-someone-else',
    })

    await controller.create(body, 'idem-1', consumer)

    const request = bookings.createBooking.mock.calls[0]![0]
    expect(request.userId).toBe('u-owner')
    expect(request.sourceChannel).toBe('MOBILE')
  })

  it('still demands an idempotency key', async () => {
    const startsAt = new Date(Date.now() + 60_000)
    const body = createBookingSchema.parse({
      facilityId: 'f1',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      vehicleType: 'CAR',
      vehiclePlate: 'ABC123',
      sourceChannel: 'MOBILE',
    })

    expect(() => controller.create(body, undefined, consumer)).toThrow(BadRequestException)
    expect(bookings.createBooking).not.toHaveBeenCalled()
  })

  it('passes the caller through to the service for every owner-scoped read and write', () => {
    controller.get('b1', consumer)
    controller.cancel('b1', consumer)
    controller.confirm('b1', consumer)
    controller.qr('b1', consumer)

    expect(bookings.getBooking).toHaveBeenCalledWith('b1', consumer)
    expect(bookings.cancelBooking).toHaveBeenCalledWith('b1', consumer)
    expect(bookings.confirmBooking).toHaveBeenCalledWith('b1', consumer)
    expect(tickets.issue).toHaveBeenCalledWith(consumer, 'b1')
  })

  it('lists the authenticated caller own bookings, with no way to name another user', () => {
    const query = listMyBookingsSchema.parse({})

    controller.mine(query, consumer)

    expect(bookings.listMine).toHaveBeenCalledWith(consumer, query)
  })
})
