import { Module, forwardRef } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { WhatsAppCatalogModule } from '../whatsapp-catalog/whatsapp-catalog.module';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';

@Module({
  imports: [AuditModule, forwardRef(() => WhatsAppCatalogModule)],
  controllers: [MenuController],
  providers: [MenuService, BranchAccessService, BranchTimeService],
  exports: [MenuService],
})
export class MenuModule {}
