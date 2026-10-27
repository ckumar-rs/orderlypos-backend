import { Module } from '@nestjs/common';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { CommerceModule } from '../commerce/commerce.module';
import { MessagingModule } from '../messaging/messaging.module';
import { OrdersModule } from '../orders/orders.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { ServiceDepthController, ServiceDepthPublicController } from './service-depth.controller';
import { ServiceDepthService } from './service-depth.service';

@Module({
  imports: [OrdersModule, MessagingModule, CommerceModule, ReservationsModule],
  controllers: [ServiceDepthController, ServiceDepthPublicController],
  providers: [ServiceDepthService, BranchAccessService],
})
export class ServiceDepthModule {}
