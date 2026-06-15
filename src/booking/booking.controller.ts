import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
} from '@nestjs/common'
import type { AuthUser } from '@parqin/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Public } from '../auth/decorators/public.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { BookingService } from './booking.service'
import { createBookingSchema, type CreateBookingDto } from './dto/booking.dto'

@Controller('bookings')
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  @Public()
  @Post()
  create(
    @Body(new ZodValidationPipe(createBookingSchema)) body: CreateBookingDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user?: AuthUser,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required')
    }
    if (!user && !body.guestEmail) {
      throw new BadRequestException('guestEmail is required for guest bookings')
    }

    return this.bookings.createBooking({
      facilityId: body.facilityId,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      vehicleType: body.vehicleType,
      vehiclePlate: body.vehiclePlate,
      vehicleId: body.vehicleId,
      guestEmail: body.guestEmail,
      guestPhone: body.guestPhone,
      sourceChannel: body.sourceChannel,
      userId: user?.id,
      idempotencyKey,
    })
  }

  @Public()
  @Post(':id/confirm')
  confirm(@Param('id') id: string) {
    return this.bookings.confirmBooking(id)
  }

  @Public()
  @Get(':id')
  get(@Param('id') id: string) {
    return this.bookings.getBooking(id)
  }

  @Public()
  @Delete(':id')
  cancel(@Param('id') id: string, @CurrentUser() user?: AuthUser) {
    return this.bookings.cancelBooking(id, user?.id)
  }

  @Roles('operator_staff', 'operator_admin')
  @Post(':id/check-in')
  checkIn(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.bookings.checkIn(id, user.id)
  }

  @Roles('operator_staff', 'operator_admin')
  @Post(':id/check-out')
  checkOut(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.bookings.checkOut(id, user.id)
  }
}
