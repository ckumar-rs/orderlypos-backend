import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
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
import { WhatsAppCatalogService } from './whatsapp-catalog.service';

const connectSchema = z.object({
  phoneNumberId: z.string().trim().min(1).max(40),
  wabaId: z.string().trim().min(1).max(40),
  catalogId: z.string().trim().min(1).max(40),
  businessPhone: z.string().trim().max(20).nullable().optional(),
  kapsoCustomerId: z.string().trim().max(80).nullable().optional(),
  accessToken: z.string().trim().max(2000).nullable().optional(),
});

@ApiTags('whatsapp-catalog')
@Controller('v1/whatsapp/catalog')
export class WhatsAppCatalogController {
  constructor(
    private readonly catalog: WhatsAppCatalogService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('settings.manage')
  @Get()
  async get(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.catalog.get(branchId);
  }

  @Auth('settings.manage')
  @AuditAction('whatsapp_catalog.connected', 'WhatsAppCatalogConnection')
  @Post('connect')
  @UsePipes(new ZodValidationPipe(connectSchema))
  async connect(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: z.infer<typeof connectSchema>,
  ) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.catalog.connect(user.restaurantId, branchId, body);
  }

  @Auth('settings.manage')
  @AuditAction('whatsapp_catalog.disconnected', 'WhatsAppCatalogConnection')
  @Post('disconnect')
  async disconnect(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.catalog.disconnect(branchId);
  }

  @Auth('settings.manage')
  @AuditAction('whatsapp_catalog.synced', 'WhatsAppCatalogConnection')
  @Post('sync')
  async sync(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.catalog.syncBranch(branchId);
  }

  @Auth('settings.manage')
  @Post('products/:menuItemId/retry')
  async retry(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('menuItemId') menuItemId: string,
  ) {
    await this.assertBranch(user.restaurantId, branchId);
    return this.catalog.retryItem(branchId, menuItemId);
  }

  private async assertBranch(restaurantId: string, branchId: string) {
    if (!branchId) throw new BadRequestException('branchId is required');
    await this.branchAccess.assertAccess(restaurantId, branchId);
  }
}
