import { Module } from '@nestjs/common';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { GiftCardsController } from './gift-cards.controller';
import { GiftCardsService } from './gift-cards.service';

@Module({
  controllers: [GiftCardsController],
  providers: [GiftCardsService, BranchAccessService],
  exports: [GiftCardsService],
})
export class GiftCardsModule {}
