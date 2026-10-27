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
  customerSchema,
  employeeDiscountPolicySchema,
  loyaltyRuleSchema,
  membershipTierSchema,
  rewardSchema,
  rfmLabelSchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { CustomersService } from './customers.service';

@ApiTags('customers')
@Controller('v1/customers')
export class CustomersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('customers.manage')
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('search') search?: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.list(branchId, search);
  }

  @Auth('customers.manage')
  @Get('tiers')
  async listTiers(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.listTiers(branchId);
  }

  @Auth('customers.manage')
  @Post('tiers')
  @UsePipes(new ZodValidationPipe(membershipTierSchema))
  async createTier(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.createTier(branchId, body as never);
  }

  @Auth('customers.manage')
  @Delete('tiers/:id')
  async removeTier(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.removeTier(branchId, id);
  }

  @Auth('customers.manage')
  @Get('segments')
  async segments(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.segments(branchId);
  }

  @Auth('customers.manage')
  @Get('rfm/labels')
  async listRfmLabels(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.listRfmLabels(branchId);
  }

  @Auth('customers.manage')
  @Post('rfm/labels')
  @UsePipes(new ZodValidationPipe(rfmLabelSchema))
  async createRfmLabel(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.createRfmLabel(branchId, body as never);
  }

  @Auth('customers.manage')
  @Patch('rfm/labels/:id')
  @UsePipes(new ZodValidationPipe(rfmLabelSchema))
  async updateRfmLabel(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.updateRfmLabel(branchId, id, body as never);
  }

  @Auth('customers.manage')
  @Delete('rfm/labels/:id')
  async removeRfmLabel(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.removeRfmLabel(branchId, id);
  }

  @Auth('customers.manage')
  @Post('rfm/refresh')
  async refreshRfm(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.recomputeRfm(branchId);
  }

  @Auth('customers.manage')
  @Get('analytics')
  async analytics(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.analytics(branchId);
  }

  @Auth('customers.manage')
  @Get('loyalty-rule')
  async loyaltyRule(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.loyaltyRule(branchId);
  }

  @Auth('customers.manage')
  @Post('loyalty-rule')
  @UsePipes(new ZodValidationPipe(loyaltyRuleSchema))
  async saveLoyaltyRule(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.saveLoyaltyRule(branchId, body as never);
  }

  @Auth('customers.manage')
  @Get('rewards')
  async listRewards(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.listRewards(branchId);
  }

  @Auth('customers.manage')
  @Post('rewards')
  @UsePipes(new ZodValidationPipe(rewardSchema))
  async createReward(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.createReward(branchId, body as never);
  }

  @Auth('customers.manage')
  @Delete('rewards/:id')
  async removeReward(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.removeReward(branchId, id);
  }

  @Auth('customers.manage')
  @Get('employee-discounts')
  async employeeDiscounts(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.employeeDiscounts(branchId);
  }

  @Auth('customers.manage')
  @Post('employee-discounts')
  @UsePipes(new ZodValidationPipe(employeeDiscountPolicySchema))
  async createEmployeeDiscount(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.createEmployeeDiscount(branchId, body as never);
  }

  @Auth('customers.manage')
  @Delete('employee-discounts/:id')
  async removeEmployeeDiscount(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.removeEmployeeDiscount(branchId, id);
  }

  @Auth('customers.manage')
  @Post(':id/rewards/:rewardId')
  async redeemReward(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Param('rewardId') rewardId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.redeemReward(branchId, id, rewardId);
  }

  @Auth('customers.manage')
  @Get(':id')
  async getById(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.getById(branchId, id);
  }

  @Auth('customers.manage')
  @Post()
  @UsePipes(new ZodValidationPipe(customerSchema))
  async create(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.create(branchId, body as never);
  }

  @Auth('customers.manage')
  @Patch(':id')
  @UsePipes(new ZodValidationPipe(customerSchema))
  async update(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.update(branchId, id, body as never);
  }

  @Auth('customers.manage')
  @Delete(':id')
  async remove(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.customersService.remove(branchId, id);
  }
}
