import { Module } from '@nestjs/common'
import { OperatorScopeService } from '../common/authz/operator-scope.service'
import { InventoryModule } from '../inventory/inventory.module'
import { OperatorAccessService } from '../operators/operator-access.service'
import { NotificationsModule } from '../notifications/notifications.module'
import { PaymentsModule } from '../payments/payments.module'
import { TariffModule } from '../tariff/tariff.module'
import { BookingController } from './booking.controller'
import { BookingService } from './booking.service'
import { PaymentEventsService } from './payment-events.service'
import { PaymentsWebhookController } from './payments-webhook.controller'
import { QrReplayCache } from './qr-replay.cache'
import { TicketService } from './ticket.service'

@Module({
  imports: [TariffModule, InventoryModule, PaymentsModule, NotificationsModule],
  controllers: [BookingController, PaymentsWebhookController],
  providers: [
    BookingService,
    PaymentEventsService,
    OperatorScopeService,
    OperatorAccessService,
    TicketService,
    QrReplayCache,
  ],
  exports: [BookingService],
})
export class BookingModule {}
