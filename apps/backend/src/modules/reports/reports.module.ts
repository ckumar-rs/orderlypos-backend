import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { AccountingModule } from '../accounting/accounting.module';
import { ReportSchedulesController } from './report-schedules.controller';
import { ReportSchedulesService } from './report-schedules.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { HeatmapService } from './heatmap.service';

@Module({
  imports: [AccountingModule, AuditModule],
  controllers: [ReportsController, ReportSchedulesController],
  providers: [
    ReportsService,
    HeatmapService,
    ReportSchedulesService,
    BranchAccessService,
    BranchTimeService,
  ],
  exports: [ReportsService],
})
export class ReportsModule {}
