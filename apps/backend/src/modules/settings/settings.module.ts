import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [AuditModule],
  controllers: [SettingsController],
  providers: [SettingsService, BranchAccessService],
})
export class SettingsModule {}
