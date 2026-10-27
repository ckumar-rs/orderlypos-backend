import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createWaitlistEntrySchema,
  seatWaitlistEntrySchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { WaitlistService } from './waitlist.service';

@ApiTags('waitlist')
@Controller('v1/waitlist')
export class WaitlistController {
  constructor(
    private readonly waitlistService: WaitlistService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('reservations.manage')
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.waitlistService.listWaiting(branchId);
  }

  @Auth('reservations.manage')
  @Post()
  @UsePipes(new ZodValidationPipe(createWaitlistEntrySchema))
  async create(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.waitlistService.create(branchId, body as never);
  }

  @Auth('reservations.manage')
  @Post(':id/seat')
  @UsePipes(new ZodValidationPipe(seatWaitlistEntrySchema))
  async seat(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    const { tableId } = body as { tableId?: string };
    return this.waitlistService.seat(branchId, id, tableId);
  }

  @Auth('reservations.manage')
  @Delete(':id')
  async cancel(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.waitlistService.cancel(branchId, id);
  }
}
