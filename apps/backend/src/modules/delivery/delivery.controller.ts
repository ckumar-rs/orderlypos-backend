import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  assignDriverSchema,
  deliveryStatusUpdateSchema,
  deliveryZoneSchema,
  deliveryZoneUpdateSchema,
  driverLocationSchema,
  type DeliveryStatusDto,
  type DriverLocationDto,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { AuditAction } from '../../audit/audit-action';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { DeliveryService } from './delivery.service';

@ApiTags('delivery')
@Controller('v1/delivery')
export class DeliveryController {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('delivery.manage')
  @Get('zones')
  async zones(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.delivery.listZones(branchId);
  }

  @Auth('delivery.manage')
  @AuditAction('delivery_zone.created', 'DeliveryZone')
  @Post('zones')
  @UsePipes(new ZodValidationPipe(deliveryZoneSchema))
  async createZone(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: never,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.delivery.createZone(branchId, body);
  }

  @Auth('delivery.manage')
  @AuditAction('delivery_zone.updated', 'DeliveryZone')
  @Patch('zones/:id')
  @UsePipes(new ZodValidationPipe(deliveryZoneUpdateSchema))
  async updateZone(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: never,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.delivery.updateZone(branchId, id, body);
  }

  @Auth('delivery.manage')
  @AuditAction('delivery_zone.deleted', 'DeliveryZone')
  @Delete('zones/:id')
  async deleteZone(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.delivery.deleteZone(branchId, id);
  }

  @Auth('delivery.manage')
  @Get('drivers')
  async drivers(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.delivery.listDrivers(branchId);
  }

  @Auth('delivery.manage')
  @Get()
  async list(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('history') history?: string,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.delivery.list(branchId, history === 'true');
  }

  @Auth('delivery.manage')
  @AuditAction('delivery.driver_assigned', 'Order')
  @Patch(':orderId/assign')
  @UsePipes(new ZodValidationPipe(assignDriverSchema))
  async assign(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('orderId') orderId: string,
    @Body() body: { driverId: string },
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.delivery.assignDriver(branchId, orderId, body.driverId);
  }

  @Auth('delivery.manage')
  @Patch(':orderId/location')
  @UsePipes(new ZodValidationPipe(driverLocationSchema))
  async location(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('orderId') orderId: string,
    @Body() body: DriverLocationDto,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.delivery.shareLocation(
      branchId,
      orderId,
      u.id,
      u.permissions.includes('delivery.manage'),
      body,
    );
  }

  @Auth('delivery.manage')
  @Get(':orderId/trail')
  async trail(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('orderId') orderId: string,
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.delivery.trail(branchId, orderId);
  }

  @Auth('delivery.manage')
  @Patch(':orderId/status')
  @UsePipes(new ZodValidationPipe(deliveryStatusUpdateSchema))
  async status(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('orderId') orderId: string,
    @Body() body: { status: DeliveryStatusDto },
  ) {
    await this.branchAccess.assertAccess(u.restaurantId, branchId);
    return this.delivery.setStatus(branchId, orderId, body.status);
  }
}
