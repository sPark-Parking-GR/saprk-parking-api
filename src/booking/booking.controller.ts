import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser, UserRole } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { BookingService } from './booking.service'
import { TicketService } from './ticket.service'
import {
  createBookingSchema,
  listBookingsSchema,
  listMyBookingsSchema,
  verifyTicketSchema,
  type CreateBookingDto,
  type ListBookingsDto,
  type ListMyBookingsDto,
  type VerifyTicketDto,
} from './dto/booking.dto'

// Controller-layer gate for the owner-or-staff endpoints. Every booking belongs to an
// account, so these are closed to anonymous callers; the ownership predicate itself needs
// a database read and lives in the service.
const BOOKING_ACTOR_ROLES: UserRole[] = [
  'user',
  'operator_staff',
  'operator_admin',
  'platform_admin',
  'super_admin',
]

@Controller('bookings')
export class BookingController {
  constructor(
    private readonly bookings: BookingService,
    private readonly tickets: TicketService,
  ) {}

  // Declared before ':id' so the literal route can never be shadowed by a booking id.
  @Roles(...BOOKING_ACTOR_ROLES)
  @Get('mine')
  mine(
    @Query(new ZodValidationPipe(listMyBookingsSchema)) query: ListMyBookingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.bookings.listMine(user, query)
  }

  /**
   * Barrier scan. 20/min per caller is deliberately below every other operator route: a
   * scanner running at a real gate needs a handful of calls a minute, while the endpoint
   * takes a credential and answers with booking data, so anything faster is either a
   * misconfigured client or someone grinding codes.
   */
  @Roles('operator_staff', 'operator_admin')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('verify-qr')
  @HttpCode(200)
  verifyTicket(
    @Body(new ZodValidationPipe(verifyTicketSchema)) body: VerifyTicketDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tickets.verify(user, body)
  }

  @Roles('operator_staff', 'operator_admin', 'platform_admin', 'super_admin')
  @Get()
  list(
    @Query(new ZodValidationPipe(listBookingsSchema)) query: ListBookingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.bookings.adminList(user, query)
  }

  @Roles(...BOOKING_ACTOR_ROLES)
  @Post()
  create(
    @Body(new ZodValidationPipe(createBookingSchema)) body: CreateBookingDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required')
    }

    return this.bookings.createBooking({
      facilityId: body.facilityId,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      vehicleType: body.vehicleType,
      vehiclePlate: body.vehiclePlate,
      vehicleId: body.vehicleId,
      sourceChannel: body.sourceChannel,
      userId: user.id,
      idempotencyKey,
    })
  }

  @Roles(...BOOKING_ACTOR_ROLES)
  @Post(':id/confirm')
  confirm(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.bookings.confirmBooking(id, user)
  }

  @Roles(...BOOKING_ACTOR_ROLES)
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.bookings.getBooking(id, user)
  }

  // The owner's rotating code. Cheap enough to poll while the ticket is on screen, which
  // is what a code that rotates every minute requires.
  @Roles(...BOOKING_ACTOR_ROLES)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':id/qr')
  qr(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.issue(user, id)
  }

  @Roles(...BOOKING_ACTOR_ROLES)
  @Delete(':id')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.bookings.cancelBooking(id, user)
  }

  @Roles('operator_staff', 'operator_admin')
  @Post(':id/check-in')
  checkIn(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.bookings.checkIn(id, user)
  }

  @Roles('operator_staff', 'operator_admin')
  @Post(':id/check-out')
  checkOut(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.bookings.checkOut(id, user)
  }
}
