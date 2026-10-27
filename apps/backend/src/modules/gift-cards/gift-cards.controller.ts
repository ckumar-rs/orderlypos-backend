import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  issueGiftCardSchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { GiftCardsService } from './gift-cards.service';

@ApiTags('gift-cards')
@Controller('v1/gift-cards')
export class GiftCardsController {
  constructor(
    private readonly giftCardsService: GiftCardsService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('customers.manage')
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.giftCardsService.list(branchId);
  }

  @Auth('customers.manage')
  @Get(':code')
  async getByCode(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('code') code: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.giftCardsService.getByCode(branchId, code);
  }

  @Auth('customers.manage')
  @Post()
  @UsePipes(new ZodValidationPipe(issueGiftCardSchema))
  async issue(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.giftCardsService.issue(branchId, body as never);
  }
}
