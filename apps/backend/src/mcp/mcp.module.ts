import { Module } from '@nestjs/common';
import { BranchAccessService } from '../common/services/branch-access.service';
import { StaffApiKeyGuard } from '../common/guards/staff-api-key.guard';
import { OrdersModule } from '../modules/orders/orders.module';
import { ReservationsModule } from '../modules/reservations/reservations.module';
import { DashboardModule } from '../modules/dashboard/dashboard.module';
import { MenuModule } from '../modules/menu/menu.module';
import { TablesModule } from '../modules/tables/tables.module';
import { DeliveryModule } from '../modules/delivery/delivery.module';
import { AccountingModule } from '../modules/accounting/accounting.module';
import { HrModule } from '../modules/hr/hr.module';
import { MarketingModule } from '../modules/marketing/marketing.module';
import { OperationsModule } from '../modules/operations/operations.module';
import { ReportsModule } from '../modules/reports/reports.module';
import { AttendanceModule } from '../modules/attendance/attendance.module';
import { McpController } from './mcp.controller';
import { McpToolsBuilder } from './mcp-tools.builder';

@Module({
  imports: [
    OrdersModule,
    ReservationsModule,
    DashboardModule,
    MenuModule,
    TablesModule,
    AttendanceModule,
    DeliveryModule,
    HrModule,
    AccountingModule,
    ReportsModule,
    MarketingModule,
    OperationsModule,
  ],
  controllers: [McpController],
  providers: [McpToolsBuilder, StaffApiKeyGuard, BranchAccessService],
})
export class McpModule {}
