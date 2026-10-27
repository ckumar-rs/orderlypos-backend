import { Body, Controller, Get, Post, Query, UsePipes } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  outboundTestSchema,
  type OutboundTestDto,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { MessagingService } from './messaging.service';

@ApiTags('messaging')
@Controller('v1/messaging')
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('settings.manage')
  @Post('test')
  @UsePipes(new ZodValidationPipe(outboundTestSchema))
  async test(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: OutboundTestDto,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.messaging.dispatch({
      restaurantId: user.restaurantId,
      branchId,
      channel: body.channel,
      purpose: 'TEST',
      to: body.to,
      body: body.body,
    });
  }

  @Auth('customers.manage')
  @Get('outbox')
  async outbox(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.messaging.list(user.restaurantId, branchId);
  }
}
