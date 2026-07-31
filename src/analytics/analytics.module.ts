import { Module } from '@nestjs/common'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { AnalyticsController } from './analytics.controller'
import { AnalyticsService } from './analytics.service'

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, OperatorScopeService],
})
export class AnalyticsModule {}
