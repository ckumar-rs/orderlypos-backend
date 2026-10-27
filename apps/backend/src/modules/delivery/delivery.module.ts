import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';

@Module({
  imports: [AuditModule],
  controllers: [DeliveryController],
  providers: [DeliveryService, BranchAccessService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
