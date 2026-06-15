import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { AuthModule } from './auth/auth.module'
import { AuthGuard } from './auth/guards/auth.guard'
import { RolesGuard } from './auth/guards/roles.guard'
import { BookingModule } from './booking/booking.module'
import { DomainExceptionFilter } from './common/filters/domain-exception.filter'
import { FacilitiesModule } from './facilities/facilities.module'
import { InventoryModule } from './inventory/inventory.module'
import { JobsModule } from './jobs/jobs.module'
import { MapsModule } from './maps/maps.module'
import { NotificationsModule } from './notifications/notifications.module'
import { PaymentsModule } from './payments/payments.module'
import { PrismaModule } from './prisma/prisma.module'
import { TariffModule } from './tariff/tariff.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuthModule,
    MapsModule,
    PaymentsModule,
    NotificationsModule,
    TariffModule,
    InventoryModule,
    FacilitiesModule,
    BookingModule,
    JobsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
