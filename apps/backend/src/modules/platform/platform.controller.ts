import { Body, Controller, ForbiddenException, Get, Headers, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { SessionUser } from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { PlatformGraphqlService } from './platform-graphql.service';
import { canReadFields, canWriteFieldValue } from './field-entities';
import { PlatformService } from './platform.service';

@ApiTags('platform')
@Controller('v1/platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly graphql: PlatformGraphqlService,
    private readonly access: BranchAccessService,
  ) {}

  @Auth('reports.access')
  @Get('franchise')
  franchise(@CurrentUser() user: SessionUser) {
    return this.platform.franchise(user.restaurantId);
  }

  @Auth('settings.manage')
  @Put('franchise')
  setPriceLock(@CurrentUser() user: SessionUser, @Body() body: { priceLock?: boolean }) {
    return this.platform.setPriceLock(user.restaurantId, Boolean(body.priceLock));
  }

  @Auth('settings.manage')
  @Get('devices')
  async devices(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.devices(branchId);
  }

  @Auth('orders.create')
  @Post('devices')
  async register(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { name?: string },
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.registerDevice(branchId, body.name ?? 'Register');
  }

  @Auth('settings.manage')
  @Put('devices/:id')
  async saveConfig(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { config?: Record<string, unknown> },
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.saveDeviceConfig(branchId, id, body.config ?? {});
  }

  @Auth('orders.create')
  @Post('devices/heartbeat')
  heartbeat(
    @Headers('x-device-token') token: string | undefined,
    @Body() body: { version?: string },
  ) {
    return this.platform.heartbeat(token, body.version);
  }

  @Auth('orders.create')
  @Get('devices/me')
  me(@Headers('x-device-token') token: string | undefined) {
    return this.platform.deviceConfig(token);
  }

  @Auth('settings.manage')
  @Get('security')
  security(
    @CurrentUser() user: SessionUser,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    return this.platform.security(user.restaurantId, headers);
  }

  @Auth('settings.manage')
  @Put('security')
  saveSecurity(
    @CurrentUser() user: SessionUser,
    @Body() body: { ipAllowList?: string; requireDevice?: boolean },
  ) {
    return this.platform.saveSecurity(user.restaurantId, {
      ipAllowList: body.ipAllowList ?? '',
      requireDevice: Boolean(body.requireDevice),
    });
  }

  @Auth()
  @Get('fields')
  async fields(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('entity') entity = 'CUSTOMER',
    @Query('entityId') entityId?: string,
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    if (!canReadFields(user.permissions, entity, Boolean(entityId))) {
      throw new ForbiddenException('This login cannot read those fields');
    }
    return this.platform.fields(branchId, entity, entityId);
  }

  @Auth('settings.manage')
  @Post('fields')
  async addField(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { entity?: string; key?: string; label?: string },
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.addField(branchId, {
      entity: body.entity || 'CUSTOMER',
      key: body.key ?? '',
      label: body.label ?? '',
    });
  }

  @Auth()
  @Put('fields/:id')
  async saveValue(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { entityId?: string; value?: string },
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    const field = await this.platform.fieldEntity(branchId, id);
    if (!canWriteFieldValue(user.permissions, field)) {
      throw new ForbiddenException('This login cannot edit those fields');
    }
    return this.platform.saveFieldValue(branchId, id, body.entityId ?? '', body.value ?? '');
  }

  @Auth('reports.access')
  @Get('saved-reports')
  async savedReports(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.savedReports(branchId);
  }

  @Auth('reports.access')
  @Post('saved-reports')
  async addSavedReport(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { name?: string; reportKey?: string; days?: number },
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.addSavedReport(branchId, {
      name: body.name ?? '',
      reportKey: body.reportKey ?? 'sales-daily',
      days: Number(body.days ?? 7),
    });
  }

  @Auth('reports.access')
  @Post('saved-reports/:id/run')
  async runSaved(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.runSavedReport(branchId, id);
  }

  @Auth('settings.manage')
  @Get('automation')
  async rules(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.rules(branchId);
  }

  @Auth('settings.manage')
  @Post('automation')
  async addRule(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: {
      name?: string;
      trigger?: string;
      actions?: unknown;
      emailTo?: string;
      phoneTo?: string;
      webhookUrl?: string;
      taskTitle?: string;
      nextRuleId?: string;
    },
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.addRule(branchId, {
      name: body.name ?? '',
      trigger: body.trigger ?? '',
      actions: body.actions,
      emailTo: body.emailTo,
      phoneTo: body.phoneTo,
      webhookUrl: body.webhookUrl,
      taskTitle: body.taskTitle,
      nextRuleId: body.nextRuleId,
    });
  }

  @Auth('settings.manage')
  @Get('automation/tasks')
  async tasks(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.tasks(branchId);
  }

  @Auth('settings.manage')
  @Put('automation/tasks/:id')
  async completeTask(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.completeTask(branchId, id);
  }

  @Auth('settings.manage')
  @Put('automation/:id')
  async setRule(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { active?: boolean },
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.setRuleActive(branchId, id, Boolean(body.active));
  }

  @Auth('reports.access')
  @Get('bi')
  async bi(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.bi(branchId);
  }

  @Auth('orders.create')
  @Get('conflicts')
  async conflicts(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.conflicts(branchId);
  }

  @Auth('orders.create')
  @Post('conflicts/:id/resolve')
  async resolve(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.resolveConflict(branchId, id);
  }

  @Auth()
  @Post('graphql')
  query(
    @CurrentUser() user: SessionUser,
    @Body() body: { query?: string; variables?: Record<string, unknown> },
  ) {
    return this.graphql.run(body.query ?? '', body.variables, user);
  }
}
