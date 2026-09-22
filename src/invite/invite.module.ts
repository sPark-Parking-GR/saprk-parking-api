import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { OperatorsModule } from '../operators/operators.module'
import { SubscriptionsModule } from '../subscriptions/subscriptions.module'
import { InviteController } from './invite.controller'
import { InviteTokenService } from './invite-token.service'
import { InviteService } from './invite.service'

@Module({
  imports: [NotificationsModule, AuthModule, OperatorsModule, SubscriptionsModule],
  controllers: [InviteController],
  providers: [InviteService, InviteTokenService],
  exports: [InviteTokenService],
})
export class InviteModule {}
