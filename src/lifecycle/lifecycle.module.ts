import { Module } from '@nestjs/common'
import { LifecycleAdminService } from './lifecycle-admin.service'
import { LifecycleApprovalService } from './lifecycle-approval.service'
import { LifecycleImpactService } from './lifecycle-impact.service'
import { LifecyclePurgeService } from './lifecycle-purge.service'
import { LifecycleService } from './lifecycle.service'

@Module({
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
