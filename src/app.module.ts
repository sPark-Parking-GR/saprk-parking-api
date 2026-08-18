import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { LoggerModule } from 'nestjs-pino'
import { AdminModule } from './admin/admin.module'
import { AnalyticsModule } from './analytics/analytics.module'
import { AuditModule } from './audit/audit.module'
import { IdentityModule } from './identity/identity.module'
import { AuthModule } from './auth/auth.module'
import { AdminRouteGuard } from './auth/guards/admin-route.guard'
import { AuthGuard } from './auth/guards/auth.guard'
import { OrgPermissionGuard } from './auth/guards/org-permission.guard'
import { PermissionGuard } from './auth/guards/permission.guard'
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
import { ManagersModule } from './managers/managers.module'
import { MapsModule } from './maps/maps.module'
import { NotificationsModule } from './notifications/notifications.module'
import { OperatorsModule } from './operators/operators.module'
import { PaymentsModule } from './payments/payments.module'
import { PrismaModule } from './prisma/prisma.module'
import { SubscriptionsModule } from './subscriptions/subscriptions.module'
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
    SubscriptionsModule,
    MapsModule,
    PaymentsModule,
    NotificationsModule,
    TariffModule,
    InventoryModule,
    FacilitiesModule,
    BookingModule,
    InviteModule,
    OperatorsModule,
    ManagersModule,
    JobsModule,
    IngestionModule,
    AnalyticsModule,
    AuditModule,
    IdentityModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    // Declaration order is execution order, and it is load-bearing. AuthGuard must run
    // first: it is what populates request.user and what turns an anonymous or revoked
    // caller into a 401 — put either authorization guard ahead of it and every unauthorized
    // request would answer 403 on an empty user instead. RolesGuard then PermissionGuard is
    // coarse-before-fine, so the failure a caller sees is the same one they saw before
    // permissions existed. Every global guard must return true for a handler to run, so a
    // route carrying both @Roles and @RequirePermission is a strict intersection by
    // construction — neither guard can ever re-admit a caller the other refused.
    // AdminRouteGuard sits between them for the same coarse-before-fine reason: it is the
    // only guard that decides from the URL rather than from decorators, so it must not be
    // reachable before request.user exists, and it should refuse an operator on /admin/*
    // before either decorator-driven guard gets a say.
    { provide: APP_GUARD, useClass: AdminRouteGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    // Last, and finest: org scopes narrow WITHIN one operator, so they only ever matter
    // for a caller the coarser guards have already admitted. Undecorated routes pass
    // through untouched, so adding it here changed nothing until a route opted in.
    { provide: APP_GUARD, useClass: OrgPermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
})
export class AppModule {}
