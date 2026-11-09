import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  customFieldSchema,
  customFieldUpdateSchema,
  type CustomFieldDto,
  type CustomFieldUpdateDto,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
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

  /** Specific paths before devices/:id */
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

  @Auth('settings.manage')
  @Delete('devices/:id')
  async deleteDevice(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.deleteDevice(branchId, id);
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
  @UsePipes(new ZodValidationPipe(customFieldSchema))
  async addField(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: CustomFieldDto,
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.addField(branchId, {
      entity: body.entity || 'CUSTOMER',
      key: body.key ?? '',
      label: body.label ?? '',
    });
  }

  @Auth('settings.manage')
  @Patch('fields/:id')
  @UsePipes(new ZodValidationPipe(customFieldUpdateSchema))
  async updateField(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: CustomFieldUpdateDto,
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.updateField(branchId, id, body);
  }

  @Auth('settings.manage')
  @Delete('fields/:id')
  async deleteField(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.deleteField(branchId, id);
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
  @Put('saved-reports/:id')
  async updateSavedReport(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { name?: string; reportKey?: string; days?: number },
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.updateSavedReport(branchId, id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.reportKey !== undefined ? { reportKey: body.reportKey } : {}),
      ...(body.days !== undefined ? { days: Number(body.days) } : {}),
    });
  }

  @Auth('reports.access')
  @Delete('saved-reports/:id')
  async deleteSavedReport(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.deleteSavedReport(branchId, id);
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
    @Body()
    body: {
      name?: string;
      trigger?: string;
      actions?: unknown;
      emailTo?: string;
      phoneTo?: string;
      webhookUrl?: string;
      taskTitle?: string;
      nextRuleId?: string;
      active?: boolean;
    },
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    const keys = Object.keys(body ?? {}).filter((k) => k !== 'active');
    if (keys.length === 0 && body.active !== undefined) {
      return this.platform.setRuleActive(branchId, id, Boolean(body.active));
    }
    return this.platform.updateRule(branchId, id, {
      name: body.name,
      trigger: body.trigger,
      actions: body.actions,
      emailTo: body.emailTo,
      phoneTo: body.phoneTo,
      webhookUrl: body.webhookUrl,
      taskTitle: body.taskTitle,
      nextRuleId: body.nextRuleId,
      active: body.active,
    });
  }

  @Auth('settings.manage')
  @Delete('automation/:id')
  async deleteRule(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access.assertAccess(user.restaurantId, branchId);
    return this.platform.deleteRule(branchId, id);
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
