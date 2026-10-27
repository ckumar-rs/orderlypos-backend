import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createReservationSchema,
  reservationDepositSchema,
  updateReservationStatusSchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { ReservationsService } from './reservations.service';

@ApiTags('reservations')
@Controller('v1/reservations')
export class ReservationsController {
  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('reservations.manage')
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('date') date?: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.reservationsService.list(branchId, date);
  }

  @Auth('reservations.manage')
  @Post()
  @UsePipes(new ZodValidationPipe(createReservationSchema))
  async create(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.reservationsService.create(branchId, body as never, {}, user.id);
  }

  @Auth('reservations.manage')
  @Get('forecast')
  async forecast(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.reservationsService.forecast(branchId);
  }

  @Auth('reservations.manage')
  @Get('deposits')
  async deposits(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.reservationsService.deposits(branchId);
  }

  @Auth('reservations.manage')
  @Post(':id/sms')
  async sms(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.reservationsService.sendSms(branchId, id);
  }

  @Auth('reservations.manage')
  @Post(':id/assign-table')
  async assignTable(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { seating?: 'INDOOR' | 'OUTDOOR' },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.reservationsService.assignTable(branchId, id, body?.seating);
  }

  @Auth('reservations.manage')
  @Post(':id/deposit')
  @UsePipes(new ZodValidationPipe(reservationDepositSchema))
  async deposit(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.reservationsService.collectDeposit(branchId, user.id, id, body as never);
  }

  @Auth('reservations.manage')
  @Post(':id/deposit/refund')
  async refundDeposit(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.reservationsService.refundDeposit(branchId, user.id, id);
  }

  @Auth('reservations.manage')
  @Post(':id/deposit/forfeit')
  async forfeitDeposit(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.reservationsService.forfeitDeposit(branchId, user.id, id);
  }

  @Auth('reservations.manage')
  @Patch(':id/status')
  @UsePipes(new ZodValidationPipe(updateReservationStatusSchema))
  async updateStatus(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    const { status } = body as { status: never };
    return this.reservationsService.updateStatus(branchId, id, status, user.id);
  }
}
