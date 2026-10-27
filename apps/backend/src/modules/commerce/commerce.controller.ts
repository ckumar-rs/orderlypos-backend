import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { SessionUser } from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { CommerceService } from './commerce.service';

@ApiTags('commerce')
@Controller('v1/commerce')
export class CommerceController {
  constructor(
    private readonly commerce: CommerceService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('settings.manage')
  @Get('gateways')
  gateways(@CurrentUser() user: SessionUser) {
    return this.commerce.listGateways(user.restaurantId);
  }

  @Auth('settings.manage')
  @Post('gateways/:provider')
  saveGateway(
    @CurrentUser() user: SessionUser,
    @Param('provider') provider: string,
    @Body() body: {
      enabled: boolean;
      baseUrl?: string | null;
      keyId?: string | null;
      secret?: string | null;
      webhookSecret?: string | null;
    },
  ) {
    return this.commerce.saveGateway(user.restaurantId, provider, body);
  }

  @Auth('bills.print')
  @Post('intents')
  async intent(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { orderId: string; provider: string; amount: number },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.commerce.createIntent(branchId, user.restaurantId, body.orderId, body.provider, Number(body.amount));
  }

  @Auth('settings.manage')
  @Get('terminals')
  async terminals(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.commerce.listTerminals(branchId);
  }

  @Auth('settings.manage')
  @Post('terminals')
  async saveTerminal(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body()
    body: {
      id?: string;
      provider: string;
      name: string;
      enabled: boolean;
      baseUrl?: string | null;
      merchantId?: string | null;
      terminalId?: string | null;
      secret?: string | null;
    },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.commerce.saveTerminal(branchId, body);
  }

  @Auth('bills.print')
  @Post('terminals/push')
  async push(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { terminalId: string; orderId: string; amount: number },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.commerce.pushToTerminal(branchId, body.terminalId, body.orderId, Number(body.amount));
  }

  @Auth('bills.print')
  @Get('house-accounts')
  async house(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.commerce.listHouse(branchId);
  }

  @Auth('settings.manage')
  @Post('house-accounts')
  async createHouse(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { name: string; customerId?: string | null; creditLimit?: number; notes?: string | null },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.commerce.createHouse(branchId, body);
  }

  @Auth('settings.manage')
  @Patch('house-accounts/:id')
  async updateHouse(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { name: string; customerId?: string | null; creditLimit?: number; notes?: string | null },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.commerce.updateHouse(branchId, id, body);
  }

  @Auth('bills.print')
  @Post('house-accounts/:id/entries')
  async houseEntry(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { kind: 'ADVANCE' | 'CHARGE'; amount: number; reference?: string; orderId?: string; reservationId?: string },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.commerce.postHouse(branchId, user.id, id, body);
  }

  @Auth('settings.manage')
  @Get('fleet')
  async fleet(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.commerce.listFleet(branchId);
  }

  @Auth('settings.manage')
  @Post('fleet/:provider')
  async saveFleet(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('provider') provider: string,
    @Body() body: { enabled: boolean; baseUrl?: string | null; apiKey?: string | null },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.commerce.saveFleet(branchId, provider, body);
  }

  @Auth('delivery.manage')
  @Post('fleet/:provider/dispatch')
  async dispatch(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('provider') provider: string,
    @Body() body: { orderId: string },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.commerce.dispatch(branchId, body.orderId, provider);
  }
}
