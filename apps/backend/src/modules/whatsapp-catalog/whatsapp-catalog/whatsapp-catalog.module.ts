import { Module, forwardRef } from '@nestjs/common';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { OrdersModule } from '../orders/orders.module';
import { CatalogOrderService } from './catalog-order.service';
import { WhatsAppCatalogPublicController } from './whatsapp-catalog-public.controller';
import { WhatsAppCatalogController } from './whatsapp-catalog.controller';
import { WhatsAppCatalogService } from './whatsapp-catalog.service';

@Module({
  imports: [forwardRef(() => OrdersModule)],
  controllers: [WhatsAppCatalogController, WhatsAppCatalogPublicController],
  providers: [WhatsAppCatalogService, CatalogOrderService, BranchAccessService],
  exports: [WhatsAppCatalogService, CatalogOrderService],
})
export class WhatsAppCatalogModule {}
