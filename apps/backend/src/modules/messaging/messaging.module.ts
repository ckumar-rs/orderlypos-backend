import { Global, Module } from '@nestjs/common';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';

@Global()
@Module({
  controllers: [MessagingController],
  providers: [MessagingService, BranchAccessService],
  exports: [MessagingService],
})
export class MessagingModule {}
