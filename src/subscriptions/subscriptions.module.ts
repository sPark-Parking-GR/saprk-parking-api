import { Module } from '@nestjs/common'
import { EntitlementService } from './entitlement.service'
import { SubscriptionAdminService } from './subscription-admin.service'

// EntitlementService is exported because the quota it enforces is consumed at the write
// paths that create the quota-bearing resources — facilities, tariff plans and staff seats
// — not here. SubscriptionAdminService is exported for the admin controller only.
@Module({
  providers: [EntitlementService, SubscriptionAdminService],
  exports: [EntitlementService, SubscriptionAdminService],
})
export class SubscriptionsModule {}
