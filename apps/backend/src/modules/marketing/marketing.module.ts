import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { MarketingController } from './marketing.controller';
import { MarketingService } from './marketing.service';

@Module({
  imports: [AuditModule],
  controllers: [MarketingController],
  providers: [MarketingService, BranchAccessService, BranchTimeService],
  exports: [MarketingService],
})
export class MarketingModule {}
