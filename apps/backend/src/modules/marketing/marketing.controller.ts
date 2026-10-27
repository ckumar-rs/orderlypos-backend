import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  campaignSchema,
  couponSchema,
  promotionSchema,
  type CampaignDto,
  type CouponDto,
  type PromotionDto,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { AuditAction } from '../../audit/audit-action';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuditService } from '../../audit/audit.service';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { toCsv } from '../reports/csv';
import { MarketingService } from './marketing.service';

@ApiTags('marketing')
@Controller('v1/marketing')
export class MarketingController {
  constructor(
    private readonly marketing: MarketingService,
    private readonly branchAccess: BranchAccessService,
    private readonly audit: AuditService,
  ) {}

  private access(u: SessionUser, branchId: string) {
    return this.branchAccess.assertAccess(u.restaurantId, branchId);
  }

  @Auth('marketing.manage')
  @Get('coupons')
  async coupons(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.marketing.listCoupons(branchId);
  }

  @Auth('marketing.manage')
  @AuditAction('coupon.created', 'Coupon')
  @Post('coupons')
  @UsePipes(new ZodValidationPipe(couponSchema))
  async createCoupon(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: CouponDto,
  ) {
    await this.access(u, branchId);
    return this.marketing.createCoupon(branchId, body);
  }

  @Auth('marketing.manage')
  @AuditAction('coupon.toggled', 'Coupon')
  @Patch('coupons/:id/active')
  async couponActive(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { isActive: boolean },
  ) {
    await this.access(u, branchId);
    return this.marketing.setCouponActive(branchId, id, !!body.isActive);
  }

  @Auth('marketing.manage')
  @AuditAction('coupon.deleted', 'Coupon')
  @Delete('coupons/:id')
  async deleteCoupon(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.marketing.deleteCoupon(branchId, id);
  }

  @Auth('marketing.manage')
  @Get('promotions')
  async promotions(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.marketing.listPromotions(branchId);
  }

  @Auth('marketing.manage')
  @AuditAction('promotion.created', 'Promotion')
  @Post('promotions')
  @UsePipes(new ZodValidationPipe(promotionSchema))
  async createPromotion(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: PromotionDto,
  ) {
    await this.access(u, branchId);
    return this.marketing.createPromotion(branchId, body);
  }

  @Auth('marketing.manage')
  @AuditAction('promotion.toggled', 'Promotion')
  @Patch('promotions/:id/active')
  async promotionActive(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { isActive: boolean },
  ) {
    await this.access(u, branchId);
    return this.marketing.setPromotionActive(branchId, id, !!body.isActive);
  }

  @Auth('marketing.manage')
  @AuditAction('promotion.deleted', 'Promotion')
  @Delete('promotions/:id')
  async deletePromotion(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.marketing.deletePromotion(branchId, id);
  }

  @Auth('marketing.manage')
  @Get('campaigns')
  async campaigns(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.marketing.listCampaigns(branchId);
  }

  @Auth('marketing.manage')
  @AuditAction('campaign.created', 'Campaign')
  @Post('campaigns')
  @UsePipes(new ZodValidationPipe(campaignSchema))
  async createCampaign(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: CampaignDto,
  ) {
    await this.access(u, branchId);
    return this.marketing.createCampaign(branchId, body);
  }

  @Auth('marketing.manage')
  @AuditAction('campaign.deleted', 'Campaign')
  @Delete('campaigns/:id')
  async deleteCampaign(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.marketing.deleteCampaign(branchId, id);
  }

  @Auth('marketing.manage')
  @Get('campaigns/:id/audience')
  async audience(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    const { recipients } = await this.marketing.audience(branchId, id);
    return { count: recipients.length, recipients: recipients.slice(0, 50) };
  }

  @Auth('marketing.manage')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('campaigns/:id/send')
  async sendCampaign(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    const result = await this.marketing.send(branchId, id);
    await this.audit.record({
      userId: u.id,
      action: 'campaign.sent',
      entity: 'Campaign',
      entityId: id,
      metadata: result,
    });
    return result;
  }

  @Auth('marketing.manage', 'data.export')
  @Get('campaigns/:id/audience.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async audienceCsv(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    const { campaign, recipients } = await this.marketing.audience(
      branchId,
      id,
    );
    return toCsv(
      ['Name', campaign.channel === 'EMAIL' ? 'Email' : 'Phone', 'Message'],
      recipients.map((r) => [r.name, r.contact, campaign.message]),
    );
  }
}
