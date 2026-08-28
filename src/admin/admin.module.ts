import { Module } from '@nestjs/common'
import { LifecycleModule } from '../lifecycle/lifecycle.module'
import { DriverSubscriptionsModule } from '../subscriptions/driver-subscriptions.module'
import { SubscriptionsModule } from '../subscriptions/subscriptions.module'
import { AdminDriverSubscriptionsController } from './admin-driver-subscriptions.controller'
import { AdminLifecycleController } from './admin-lifecycle.controller'
import { AdminSubscriptionsController } from './admin-subscriptions.controller'

// LifecycleModule was only ever reachable through JobsModule's purge worker, which the
// e2e harness stubs out and which no HTTP request touches. Importing it here is what puts
// the lifecycle on the wire. SubscriptionsModule is imported for the same reason: its
// entitlement service is consumed by the facility, tariff and seat write paths, and this
// is what puts its administration on the wire.
@Module({
  imports: [LifecycleModule, SubscriptionsModule, DriverSubscriptionsModule],
  controllers: [
    AdminLifecycleController,
    AdminSubscriptionsController,
    AdminDriverSubscriptionsController,
  ],
})
export class AdminModule {}
