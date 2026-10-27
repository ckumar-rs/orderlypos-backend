import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { HrController } from './hr.controller';
import { HrService } from './hr.service';

@Module({
  imports: [AuditModule],
  controllers: [HrController],
  providers: [HrService, BranchAccessService, BranchTimeService],
  exports: [HrService],
})
export class HrModule {}
