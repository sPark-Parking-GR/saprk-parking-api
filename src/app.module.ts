import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { LoggerModule } from 'nestjs-pino'
import { AnalyticsModule } from './analytics/analytics.module'
import { AuditModule } from './audit/audit.module'
import { AuthModule } from './auth/auth.module'
import { AuthGuard } from './auth/guards/auth.guard'
import { RolesGuard } from './auth/guards/roles.guard'
import { BookingModule } from './booking/booking.module'
import { DomainExceptionFilter } from './common/filters/domain-exception.filter'
import { RequestContextInterceptor } from './common/interceptors/request-context.interceptor'
import { validateEnv } from './config/env.schema'
import { FacilitiesModule } from './facilities/facilities.module'
import { HealthModule } from './health/health.module'
import { IngestionModule } from './ingestion/ingestion.module'
import { InventoryModule } from './inventory/inventory.module'
import { InviteModule } from './invite/invite.module'
import { JobsModule } from './jobs/jobs.module'
import { createPinoHttpOptions } from './logger/logging.config'
import { MapsModule } from './maps/maps.module'
import { NotificationsModule } from './notifications/notifications.module'
import { OperatorsModule } from './operators/operators.module'
import { PaymentsModule } from './payments/payments.module'
import { PrismaModule } from './prisma/prisma.module'
import { TariffModule } from './tariff/tariff.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: createPinoHttpOptions(config.get<string>('NODE_ENV') ?? 'development'),
      }),
    }),
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
    InviteModule,
    OperatorsModule,
    JobsModule,
    IngestionModule,
    AnalyticsModule,
    AuditModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
})
export class AppModule {}
