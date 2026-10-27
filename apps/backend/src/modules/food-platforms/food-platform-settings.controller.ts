import {
  BadRequestException,
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
import type { SessionUser } from '@nodedr-restaurant/types';
import { z } from 'zod';
import { AuditAction } from '../../audit/audit-action';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import {
  FoodPlatformsService,
  parseFoodPlatform,
} from './food-platforms.service';

const outletSchema = z.preprocess(
  (value) => (value == null ? {} : value),
  z.object({
    outletId: z.string().trim().max(80).nullable().optional(),
  }),
);

@ApiTags('food-platforms')
@Controller('v1/food-platforms')
export class FoodPlatformSettingsController {
  constructor(
    private readonly platforms: FoodPlatformsService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('settings.manage')
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.platforms.list(branchId);
  }

  @Auth('settings.manage')
  @AuditAction('food_platform.enabled', 'FoodPlatformIntake')
  @Post(':platform/enable')
  @UsePipes(new ZodValidationPipe(outletSchema))
  async enable(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('platform') platform: string,
    @Body() body: z.infer<typeof outletSchema>,
  ) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.platforms.enable(
      branchId,
      parseFoodPlatform(platform),
      body.outletId,
    );
  }

  @Auth('settings.manage')
  @AuditAction('food_platform.rotated', 'FoodPlatformIntake')
  @Post(':platform/rotate')
  async rotate(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('platform') platform: string,
  ) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.platforms.rotate(branchId, parseFoodPlatform(platform));
  }

  @Auth('settings.manage')
  @AuditAction('food_platform.disabled', 'FoodPlatformIntake')
  @Post(':platform/disable')
  async disable(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('platform') platform: string,
  ) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.platforms.disable(branchId, parseFoodPlatform(platform));
  }

  @Auth('settings.manage')
  @AuditAction('food_platform.outlet', 'FoodPlatformIntake')
  @Patch(':platform')
  @UsePipes(new ZodValidationPipe(outletSchema))
  async setOutlet(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('platform') platform: string,
    @Body() body: z.infer<typeof outletSchema>,
  ) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.platforms.setOutlet(
      branchId,
      parseFoodPlatform(platform),
      body.outletId ?? null,
    );
  }

  @Auth('settings.manage')
  @Post(':platform/api')
  async saveApi(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('platform') platform: string,
    @Body() body: { apiBaseUrl?: string | null; apiKey?: string | null; storeOpen?: boolean },
  ) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.platforms.saveApi(branchId, parseFoodPlatform(platform), body);
  }

  @Auth('settings.manage')
  @Post(':platform/publish-menu')
  async publishMenu(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('platform') platform: string,
  ) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.platforms.publishMenu(branchId, parseFoodPlatform(platform));
  }

  @Auth('settings.manage')
  @Post(':platform/store')
  async store(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('platform') platform: string,
    @Body() body: { open: boolean },
  ) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.platforms.pushStore(branchId, parseFoodPlatform(platform), Boolean(body.open));
  }

  @Auth('settings.manage')
  @Post(':platform/stock-out')
  async stockOut(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('platform') platform: string,
    @Body() body: { itemIds?: string[] },
  ) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.platforms.pushStock(branchId, parseFoodPlatform(platform), body.itemIds ?? []);
  }

  private async assertBranch(restaurantId: string, branchId: string) {
    if (!branchId) throw new BadRequestException('branchId is required');
    await this.branchAccess.assertAccess(restaurantId, branchId);
  }
}
