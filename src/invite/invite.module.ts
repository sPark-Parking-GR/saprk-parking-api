import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { InviteController } from './invite.controller'
import { InviteService } from './invite.service'

@Module({
  imports: [NotificationsModule, AuthModule],
  controllers: [InviteController],
  providers: [InviteService],
})
export class InviteModule {}
