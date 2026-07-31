import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from '@nestjs/common'
import type { AuthUser, UserRole } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { BookingService } from './booking.service'
import {
  createBookingSchema,
  listBookingsSchema,
  type CreateBookingDto,
  type ListBookingsDto,
} from './dto/booking.dto'

// Controller-layer gate for the owner-or-staff endpoints. Every booking belongs to an
// account, so these are closed to anonymous callers; the ownership predicate itself needs
// a database read and lives in the service.
const BOOKING_ACTOR_ROLES: UserRole[] = [
  'user',
  'operator_staff',
  'operator_admin',
  'platform_admin',
]

@Controller('bookings')
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  @Roles('operator_staff', 'operator_admin', 'platform_admin')
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
