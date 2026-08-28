import { Module } from '@nestjs/common'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { SubscriptionsModule } from '../subscriptions/subscriptions.module'
import { AnalyticsController } from './analytics.controller'
import { AnalyticsService } from './analytics.service'

@Module({
  imports: [SubscriptionsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, OperatorScopeService],
})
export class AnalyticsModule {}
