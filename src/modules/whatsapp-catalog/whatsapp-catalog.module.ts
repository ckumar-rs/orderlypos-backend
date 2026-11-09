import { Module, forwardRef } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { CommerceModule } from '../commerce/commerce.module';
import { OrdersModule } from '../orders/orders.module';
import { CatalogOrderService } from './catalog-order.service';
import { WhatsAppCatalogPublicController } from './whatsapp-catalog-public.controller';
import { WhatsAppCatalogController } from './whatsapp-catalog.controller';
import { WhatsAppCatalogService } from './whatsapp-catalog.service';

@Module({
  imports: [AuditModule, forwardRef(() => OrdersModule), forwardRef(() => CommerceModule)],
  controllers: [WhatsAppCatalogController, WhatsAppCatalogPublicController],
  providers: [WhatsAppCatalogService, CatalogOrderService, BranchAccessService],
  exports: [WhatsAppCatalogService, CatalogOrderService],
})
export class WhatsAppCatalogModule {}
