import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { InviteModule } from '../invite/invite.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { AdminInviteController } from './admin-invite.controller'
import { AdminInviteService } from './admin-invite.service'
import { IdentityApprovalService } from './identity-approval.service'
import { IdentityController } from './identity.controller'
import { IdentityService } from './identity.service'

@Module({
  imports: [NotificationsModule, AuthModule, InviteModule],
  controllers: [IdentityController, AdminInviteController],
  providers: [IdentityService, IdentityApprovalService, AdminInviteService],
})
export class IdentityModule {}
