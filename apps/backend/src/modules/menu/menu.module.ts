import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';

@Module({
  imports: [AuditModule],
  controllers: [MenuController],
  providers: [MenuService, BranchAccessService, BranchTimeService],
  exports: [MenuService],
})
export class MenuModule {}
