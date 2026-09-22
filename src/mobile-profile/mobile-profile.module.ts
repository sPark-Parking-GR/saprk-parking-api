import { Module } from '@nestjs/common'
import { MobileProfileController } from './mobile-profile.controller'
import { MobileProfileService } from './mobile-profile.service'

@Module({
  controllers: [MobileProfileController],
  providers: [MobileProfileService],
})
export class MobileProfileModule {}
