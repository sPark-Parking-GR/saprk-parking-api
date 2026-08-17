import { Module } from '@nestjs/common'
import { IdentityApprovalService } from './identity-approval.service'
import { IdentityController } from './identity.controller'
import { IdentityService } from './identity.service'

@Module({
  controllers: [IdentityController],
  providers: [IdentityService, IdentityApprovalService],
})
export class IdentityModule {}
