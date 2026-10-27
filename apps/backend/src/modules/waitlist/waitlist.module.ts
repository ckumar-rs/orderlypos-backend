import { Module } from '@nestjs/common';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';

@Module({
  controllers: [WaitlistController],
  providers: [WaitlistService, BranchAccessService],
})
export class WaitlistModule {}
