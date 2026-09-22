import { Module } from '@nestjs/common'
import { NotificationsModule } from '../notifications/notifications.module'
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module'
import { EntitlementService } from './entitlement.service'
import { QuotaThresholdService } from './quota-threshold.service'
import { SubscriptionAdminService } from './subscription-admin.service'

// EntitlementService is exported because the quota it enforces is consumed at the write
// paths that create the quota-bearing resources — facilities, tariff plans and staff seats
// — not here. SubscriptionAdminService is exported for the admin controller only.
//
// QuotaThresholdService is exported to those same three write paths, which call it once
// their transaction has committed. NotificationsModule imports nothing, so pulling it in
// here closes no cycle.
//
// SubscriptionBillingModule is here for SubscriptionAdminService alone: now that an operator
// can hold a real provider subscription, an administrator's cancel or plan change has to end
// it upstream too. It imports nothing of ours, so it closes no cycle either.
@Module({
  imports: [NotificationsModule, SubscriptionBillingModule],
  providers: [EntitlementService, QuotaThresholdService, SubscriptionAdminService],
  exports: [EntitlementService, QuotaThresholdService, SubscriptionAdminService],
})
export class SubscriptionsModule {}
