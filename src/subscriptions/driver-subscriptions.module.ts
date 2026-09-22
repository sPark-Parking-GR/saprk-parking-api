import { Module } from '@nestjs/common'
import { NotificationsModule } from '../notifications/notifications.module'
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module'
import { DriverEntitlementService } from './driver-entitlement.service'
import { DriverSavingsService } from './driver-savings.service'
import { DriverMockCheckoutController } from './driver-mock-checkout.controller'
import { DriverSubscriptionAdminService } from './driver-subscription-admin.service'
import { DriverSubscriptionEventsService } from './driver-subscription-events.service'
import { DriverSubscriptionsSelfController } from './driver-subscriptions-self.controller'
import { DriverSubscriptionsSelfService } from './driver-subscriptions-self.service'
import { DriverSubscriptionsWebhookController } from './driver-subscriptions-webhook.controller'

// A module of its own rather than more providers on SubscriptionsModule: the two catalogs
// share only the BillingInterval/SubscriptionStatus enums and LIVE_SUBSCRIPTION_STATUSES,
// and nothing that consumes one has any use for the other. DriverEntitlementService is
// exported for the booking-price capture path that reads a rider's discount;
// DriverSubscriptionAdminService for the admin controller only.
//
// The self-serve controllers live here rather than in a sibling module so the admin and
// rider halves of one subject stay together and share one DriverEntitlementService instance.
// The admin exports are unchanged — AdminModule imports this module for exactly those two.
@Module({
  imports: [SubscriptionBillingModule, NotificationsModule],
  controllers: [
    DriverSubscriptionsSelfController,
    DriverSubscriptionsWebhookController,
    DriverMockCheckoutController,
  ],
  providers: [
    DriverEntitlementService,
    DriverSubscriptionAdminService,
    DriverSubscriptionsSelfService,
    DriverSubscriptionEventsService,
    DriverSavingsService,
  ],
  // DriverSavingsService is exported for JobsModule's engagement processor, which owns the
  // schedule but none of the logic.
  exports: [DriverEntitlementService, DriverSubscriptionAdminService, DriverSavingsService],
})
export class DriverSubscriptionsModule {}
