import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { SubscriptionsModule } from '../subscriptions/subscriptions.module'
import { LifecycleAdminService } from './lifecycle-admin.service'
import { LifecycleApprovalService } from './lifecycle-approval.service'
import { LifecycleImpactService } from './lifecycle-impact.service'
import { LifecyclePurgeService } from './lifecycle-purge.service'
import { LifecycleService } from './lifecycle.service'

@Module({
  imports: [SubscriptionsModule, AuthModule],
  providers: [
    LifecycleService,
    LifecyclePurgeService,
    LifecycleImpactService,
    LifecycleApprovalService,
    LifecycleAdminService,
  ],
  exports: [
    LifecycleService,
    LifecyclePurgeService,
    LifecycleImpactService,
    LifecycleApprovalService,
    LifecycleAdminService,
  ],
})
export class LifecycleModule {}
