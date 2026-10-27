import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { SessionUser } from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { AttendanceService } from './attendance.service';

@ApiTags('attendance')
@Controller('v1/attendance')
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  // Any signed-in staff member can clock themselves in/out.
  @Auth()
  @Get('me')
  async me(@CurrentUser() user: SessionUser) {
    return (await this.attendance.current(user.id)) ?? null;
  }

  @Auth()
  @Post('clock-in')
  async clockIn(
    @CurrentUser() user: SessionUser,
    @Body() body: { branchId: string; note?: string },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, body.branchId);
    return this.attendance.clockIn(user.id, body.branchId, body.note);
  }

  @Auth()
  @Post('clock-out')
  clockOut(@CurrentUser() user: SessionUser, @Body() body: { note?: string }) {
    return this.attendance.clockOut(user.id, body?.note);
  }

  @Auth('attendance.manage')
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('date') date?: string,
    @Query('userId') userId?: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.attendance.list(branchId, date, userId);
  }
}
