import { Module } from '@nestjs/common';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

@Module({
  controllers: [TablesController],
  providers: [TablesService, BranchAccessService],
  exports: [TablesService],
})
export class TablesModule {}
