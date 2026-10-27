import { Module } from '@nestjs/common';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { DeliveryModule } from '../delivery/delivery.module';
import { OrdersModule } from '../orders/orders.module';
import { CommerceController } from './commerce.controller';
import { CommercePublicController } from './commerce-public.controller';
import { CommerceService } from './commerce.service';

@Module({
  imports: [OrdersModule, DeliveryModule],
  controllers: [CommerceController, CommercePublicController],
  providers: [CommerceService, BranchAccessService],
  exports: [CommerceService],
})
export class CommerceModule {}
