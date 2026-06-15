import { Module } from '@nestjs/common'
import { InventoryModule } from '../inventory/inventory.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { PaymentsModule } from '../payments/payments.module'
import { TariffModule } from '../tariff/tariff.module'
import { BookingController } from './booking.controller'
import { BookingService } from './booking.service'
import { PaymentsWebhookController } from './payments-webhook.controller'

@Module({
  imports: [TariffModule, InventoryModule, PaymentsModule, NotificationsModule],
  controllers: [BookingController, PaymentsWebhookController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
