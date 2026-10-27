import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { SessionUser } from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ServiceDepthService } from './service-depth.service';

@ApiTags('service-depth')
@Controller('v1/service')
export class ServiceDepthController {
  constructor(
    private readonly depth: ServiceDepthService,
    private readonly branchAccess: BranchAccessService,
    private readonly webhooks: WebhooksService,
  ) {}

  @Auth('orders.create')
  @Post('repeat')
  async repeat(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { customerId: string },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.repeatLast(branchId, user.id, body.customerId);
  }

  @Auth('orders.create')
  @Get('sessions')
  async sessions(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.sessions(branchId);
  }

  @Auth('orders.create')
  @Patch('sessions/:orderId')
  async nameParty(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('orderId') orderId: string,
    @Body() body: { partyName: string },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.nameParty(branchId, orderId, body.partyName ?? '');
  }

  @Auth('tables.view')
  @Get('floors')
  async floors(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.listFloors(branchId);
  }

  @Auth('tables.manage')
  @Patch('floors/:id')
  async seating(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { seating: string },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.setSeating(branchId, id, body.seating);
  }

  @Auth('inventory.manage')
  @Get('food-cost')
  async foodCost(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.foodCost(branchId);
  }

  @Auth('inventory.manage')
  @Post('food-cost/target')
  async target(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { percent: number },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.setTarget(branchId, Number(body.percent));
  }

  @Auth('inventory.manage')
  @Post('food-cost/:menuItemId/apply')
  async apply(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('menuItemId') menuItemId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.applySuggested(branchId, menuItemId);
  }

  @Auth('inventory.manage')
  @Get('food-cost/:menuItemId/history')
  async history(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('menuItemId') menuItemId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.recipeHistory(branchId, menuItemId);
  }

  @Auth('reports.access')
  @Get('floor-report')
  async floorReport(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.floorReport(branchId, from, to);
  }

  @Auth('reports.access')
  @Get('attention')
  async attention(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.attention(branchId);
  }

  @Auth('accounting.manage')
  @Get('till')
  async till(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.currentTill(branchId);
  }

  @Auth('accounting.manage')
  @Post('till/open')
  async openTill(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { openingFloat: number },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.openTill(branchId, user.id, Number(body.openingFloat));
  }

  @Auth('accounting.manage')
  @Post('till/close')
  async closeTill(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { countedCash: number; note?: string },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.closeTill(branchId, user.id, Number(body.countedCash), body.note);
  }

  @Auth('orders.create')
  @Get('approvals')
  async approvals(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.listApprovals(branchId);
  }

  @Auth('orders.create')
  @Post('approvals')
  async requestApproval(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { kind: string; orderId?: string; note?: string },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.requestApproval(branchId, user.id, body);
  }

  @Auth('orders.cancel')
  @Post('approvals/:id/decide')
  async decide(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { approve: boolean },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.decideApproval(branchId, user.id, id, Boolean(body.approve));
  }

  @Auth('settings.manage')
  @Get('rules')
  async rules(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.rules(branchId);
  }

  @Auth('settings.manage')
  @Post('rules')
  async saveRules(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { approvalDiscountAbove?: number | null; approvalForVoid: boolean; approvalForRefund: boolean; noShowFee: number },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.saveRules(branchId, body);
  }

  @Auth('orders.create')
  @Get('curbside')
  async curbside(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.curbside(branchId);
  }

  @Auth('orders.create')
  @Post('curbside')
  async markCurbside(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { orderId: string; vehicleNote: string },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.markCurbside(branchId, body.orderId, body.vehicleNote ?? '');
  }

  @Auth('reservations.manage')
  @Post('reservations/:id/no-show')
  async noShow(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.noShow(branchId, user.id, id);
  }

  @Auth('reservations.manage')
  @Post('reservations/:id/deposit')
  async deposit(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { reference?: string; method?: 'CASH' | 'CARD' | 'UPI' | 'WALLET' | 'HOUSE' },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.collectDeposit(branchId, user.id, id, body.reference, body.method);
  }

  @Auth('reservations.manage')
  @Post('reservations/:id/text')
  async text(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.reservationText(branchId, id);
  }

  @Auth('orders.create')
  @Get('whatsapp')
  async whatsapp(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return { setup: await this.depth.whatsappSetup(branchId), orders: await this.depth.whatsappOrders(branchId) };
  }

  @Auth('settings.manage')
  @Post('whatsapp/enable')
  async enableWhatsapp(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.depth.enableWhatsapp(branchId);
  }

  @Auth('settings.manage')
  @Get('rates')
  rates(@CurrentUser() user: SessionUser) {
    return this.depth.listRates(user.restaurantId);
  }

  @Auth('settings.manage')
  @Post('rates')
  saveRate(@CurrentUser() user: SessionUser, @Body() body: { currency: string; rateToBase: number }) {
    return this.depth.saveRate(user.restaurantId, body.currency, Number(body.rateToBase));
  }

  @Auth('settings.manage')
  @Get('brands')
  brands(@CurrentUser() user: SessionUser) {
    return this.depth.listBrands(user.restaurantId);
  }

  @Auth('settings.manage')
  @Post('brands')
  createBrand(@CurrentUser() user: SessionUser, @Body() body: { name: string }) {
    return this.depth.createBrand(user.restaurantId, body.name);
  }

  @Auth('settings.manage')
  @Post('brands/assign')
  assignBrand(
    @CurrentUser() user: SessionUser,
    @Body() body: { branchId: string; brandId: string | null },
  ) {
    return this.depth.assignBrand(user.restaurantId, body.branchId, body.brandId);
  }

  @Auth('settings.manage')
  @Get('apps')
  apps(@CurrentUser() user: SessionUser) {
    return this.depth.listApps(user.restaurantId);
  }

  @Auth('settings.manage')
  @Post('apps')
  async saveApp(
    @CurrentUser() user: SessionUser,
    @Body() body: { id?: string; name: string; enabled: boolean; baseUrl?: string | null; secret?: string | null },
  ) {
    if (body.baseUrl?.trim()) await this.webhooks.checkUrl(body.baseUrl.trim());
    return this.depth.saveApp(user.restaurantId, body);
  }

  @Auth('settings.manage')
  @Post('apps/:id/test')
  testApp(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.webhooks.sendAppTest(user.restaurantId, id);
  }
}

@ApiTags('service-public')
@Controller('v1/public')
export class ServiceDepthPublicController {
  constructor(private readonly depth: ServiceDepthService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('whatsapp/orders')
  whatsapp(
    @Headers('x-webhook-secret') secret: string | undefined,
    @Body() body: { text?: string; from?: string; guestName?: string },
  ) {
    return this.depth.intakeWhatsapp(secret ?? '', body);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('menu/:token/orders/:orderNumber')
  quote(@Param('token') token: string, @Param('orderNumber') orderNumber: string) {
    return this.depth.quoteGuestOrder(token, orderNumber);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('menu/:token/orders/:orderNumber/tip')
  tip(
    @Param('token') token: string,
    @Param('orderNumber') orderNumber: string,
    @Body() body: { tipAmount: number },
  ) {
    return this.depth.guestTip(token, orderNumber, Number(body.tipAmount));
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('menu/:token/orders/:orderNumber/pay')
  pay(@Param('token') token: string, @Param('orderNumber') orderNumber: string) {
    return this.depth.guestPay(token, orderNumber);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('menu/:token/orders/:orderNumber/split')
  split(
    @Param('token') token: string,
    @Param('orderNumber') orderNumber: string,
    @Body() body: { itemId: string; guestNumber: number },
  ) {
    return this.depth.guestSplit(token, orderNumber, body.itemId, Number(body.guestNumber));
  }
}
