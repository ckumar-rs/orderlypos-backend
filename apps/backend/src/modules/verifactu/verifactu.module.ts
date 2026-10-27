import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { VerifactuController } from './verifactu.controller';
import { VerifactuService } from './verifactu.service';

@Module({
  imports: [AuditModule],
  controllers: [VerifactuController],
  providers: [VerifactuService, BranchAccessService],
  exports: [VerifactuService],
})
export class VerifactuModule {}
