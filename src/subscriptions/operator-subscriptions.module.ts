import { Module } from '@nestjs/common'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { NotificationsModule } from '../notifications/notifications.module'
import { OperatorsModule } from '../operators/operators.module'
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module'
import { OperatorMockCheckoutController } from './operator-mock-checkout.controller'
import { OperatorSubscriptionEventsService } from './operator-subscription-events.service'
import { OperatorSubscriptionsSelfController } from './operator-subscriptions-self.controller'
import { OperatorSubscriptionsSelfService } from './operator-subscriptions-self.service'
import { OperatorSubscriptionsWebhookController } from './operator-subscriptions-webhook.controller'
import { SubscriptionsModule } from './subscriptions.module'

/**
 * A module of its own rather than more providers on SubscriptionsModule, and the reason is
 * the dependency direction: this needs OperatorAccessService, which OperatorsModule exports —
 * and OperatorsModule already imports SubscriptionsModule for the quota checks. Adding the
 * self-serve controller there would close that loop into a circular import. From here the
 * chain stays acyclic: OperatorSubscriptions → Operators → Subscriptions.
 *
 * The billing controllers live here rather than in a sibling billing module, mirroring how
 * DriverSubscriptionsModule keeps one subject's self-serve, webhook and mock-checkout routes
 * together: they share OperatorSubscriptionEventsService, and splitting them would give the
 * mock page and the webhook two instances of a handler whose whole job is to be the one
 * place a purchase is applied.
 *
 * Nothing is exported. The self-serve surface is a controller and its service; every other
 * consumer of billing already depends on EntitlementService directly.
 */
@Module({
  imports: [SubscriptionsModule, OperatorsModule, NotificationsModule, SubscriptionBillingModule],
  controllers: [
    OperatorSubscriptionsSelfController,
    OperatorSubscriptionsWebhookController,
    OperatorMockCheckoutController,
  ],
  providers: [
    OperatorSubscriptionsSelfService,
    OperatorSubscriptionEventsService,
    OperatorScopeService,
  ],
})
export class OperatorSubscriptionsModule {}
