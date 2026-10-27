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
  goodsReceiptSchema,
  ingredientSchema,
  prepBatchSchema,
  prepRecipeSchema,
  purchaseOrderSchema,
  purchaseReturnSchema,
  purchaseRequestSchema,
  setRecipeSchema,
  unitConversionSchema,
  menuItemTrackingSchema,
  type MenuItemTrackingDto,
  stockAdjustmentSchema,
  stockCountSchema,
  supplierInvoiceSchema,
  supplierPaymentSchema,
  supplierQuotationSchema,
  supplierSchema,
  wasteLogSchema,
  type SetRecipeDto,
  type UnitConversionDto,
  type PurchaseOrderStatus,
  type PurchaseRequestStatus,
  type QuotationStatus,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { GoodsReceiptsService } from './goods-receipts.service';
import { InventoryService } from './inventory.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseRequestsService } from './purchase-requests.service';
import { StockService } from './stock.service';
import { SupplierInvoicesService } from './supplier-invoices.service';
import { SupplierQuotationsService } from './supplier-quotations.service';
import { WasteService } from './waste.service';
import { InventoryDepthService } from './inventory-depth.service';
import { PrepService } from './prep.service';
import { StockCountsService } from './stock-counts.service';
import { ForecastService } from './forecast.service';
import { InventoryInsightService } from './inventory-insight.service';

@ApiTags('inventory')
@Controller('v1/inventory')
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly purchaseOrdersService: PurchaseOrdersService,
    private readonly goodsReceiptsService: GoodsReceiptsService,
    private readonly wasteService: WasteService,
    private readonly stockService: StockService,
    private readonly purchaseRequestsService: PurchaseRequestsService,
    private readonly supplierQuotationsService: SupplierQuotationsService,
    private readonly supplierInvoicesService: SupplierInvoicesService,
    private readonly stockCountsService: StockCountsService,
    private readonly prepService: PrepService,
    private readonly inventoryDepthService: InventoryDepthService,
    private readonly forecastService: ForecastService,
    private readonly insight: InventoryInsightService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  // --- Ingredients ------------------------------------------------------------

  @Auth('inventory.manage')
  @Get('ingredients')
  async listIngredients(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.listIngredients(branchId);
  }

  @Auth('inventory.manage')
  @Get('ingredients/low-stock')
  async lowStockIngredients(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.lowStockIngredients(branchId);
  }

  @Auth('inventory.manage')
  @Get('ingredients/:id')
  async getIngredient(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.getIngredient(branchId, id);
  }

  @Auth('inventory.manage')
  @Post('ingredients')
  @UsePipes(new ZodValidationPipe(ingredientSchema))
  async createIngredient(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.createIngredient(branchId, body as never);
  }

  @Auth('inventory.manage')
  @Patch('ingredients/:id')
  async updateIngredient(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.updateIngredient(branchId, id, body as never);
  }

  @Auth('inventory.manage')
  @Delete('ingredients/:id')
  async deleteIngredient(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.deleteIngredient(branchId, id);
  }

  @Auth('inventory.manage')
  @Post('ingredients/:id/adjust')
  @UsePipes(new ZodValidationPipe(stockAdjustmentSchema))
  async adjustStock(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.stockService.adjustStock(branchId, user.id, id, body as never);
  }

  @Auth('inventory.manage')
  @Get('ingredients/:id/movements')
  async listMovements(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.stockService.listMovements(branchId, id);
  }

  @Auth('inventory.manage')
  @Get('ingredients/:id/batches')
  async listBatches(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.stockService.listBatches(branchId, id);
  }

  // --- Recipe costing -----------------------------------------------------------

  @Auth('inventory.manage')
  @Get('menu-items/:id/recipe')
  async getRecipe(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.getRecipe(branchId, id);
  }

  @Auth('inventory.manage')
  @Patch('menu-items/:id/recipe')
  @UsePipes(new ZodValidationPipe(setRecipeSchema))
  async setRecipe(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.setRecipe(branchId, id, body as SetRecipeDto);
  }

  @Auth('inventory.manage')
  @Get('units')
  async units(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.insight.listUnits(branchId);
  }

  @Auth('inventory.manage')
  @Post('units')
  @UsePipes(new ZodValidationPipe(unitConversionSchema))
  async createUnit(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: UnitConversionDto,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.insight.createUnit(branchId, body.fromUnit, body.toUnit, body.factor);
  }

  @Auth('inventory.manage')
  @Delete('units/:id')
  async deleteUnit(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.insight.deleteUnit(branchId, id);
  }

  @Auth('inventory.manage')
  @Get('recipes')
  async recipes(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.insight.recipes(branchId);
  }

  @Auth('inventory.manage')
  @Get('engineering')
  async engineering(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    const today = new Date().toISOString().slice(0, 10);
    return this.insight.engineering(branchId, from || today, to || today);
  }

  @Auth('inventory.manage')
  @Get('anomalies')
  async anomalies(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.insight.anomalies(branchId);
  }

  @Auth('inventory.manage')
  @Get('alerts')
  async alerts(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.insight.listAlerts(branchId);
  }

  @Auth('inventory.manage')
  @Post('alerts/run')
  async runAlerts(@CurrentUser() user: SessionUser, @Query('branchId') branchId: string) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.insight.runAlerts(branchId);
  }

  // --- Sales-driven stock tracking --------------------------------------------

  @Auth('inventory.manage')
  @Get('tracking-status')
  async trackingStatus(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.trackingSetupStatus(branchId);
  }

  @Auth('inventory.manage')
  @Get('menu-items/:id/tracking')
  async getTracking(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.getTracking(branchId, id);
  }

  @Auth('inventory.manage')
  @Patch('menu-items/:id/tracking')
  @UsePipes(new ZodValidationPipe(menuItemTrackingSchema))
  async setTracking(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.setTracking(
      branchId,
      id,
      body as MenuItemTrackingDto,
    );
  }

  // --- Suppliers ----------------------------------------------------------------

  @Auth('inventory.manage')
  @Get('suppliers')
  async listSuppliers(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.listSuppliers(branchId);
  }

  @Auth('inventory.manage')
  @Get('suppliers/:id')
  async getSupplier(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.getSupplier(branchId, id);
  }

  @Auth('inventory.manage')
  @Post('suppliers')
  @UsePipes(new ZodValidationPipe(supplierSchema))
  async createSupplier(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.createSupplier(branchId, body as never);
  }

  @Auth('inventory.manage')
  @Patch('suppliers/:id')
  async updateSupplier(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.updateSupplier(branchId, id, body as never);
  }

  @Auth('inventory.manage')
  @Delete('suppliers/:id')
  async deleteSupplier(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.deleteSupplier(branchId, id);
  }

  // --- Purchase orders ------------------------------------------------------------

  @Auth('inventory.manage')
  @Get('purchase-orders')
  async listPurchaseOrders(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('status') status?: PurchaseOrderStatus,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.purchaseOrdersService.listPurchaseOrders(branchId, status);
  }

  @Auth('inventory.manage')
  @Get('purchase-orders/:id')
  async getPurchaseOrder(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.purchaseOrdersService.getPurchaseOrder(branchId, id);
  }

  @Auth('inventory.manage')
  @Post('purchase-orders')
  @UsePipes(new ZodValidationPipe(purchaseOrderSchema))
  async createPurchaseOrder(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.purchaseOrdersService.createPurchaseOrder(
      branchId,
      user.id,
      body as never,
    );
  }

  @Auth('inventory.manage')
  @Patch('purchase-orders/:id/status')
  async updatePurchaseOrderStatus(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { status: PurchaseOrderStatus },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.purchaseOrdersService.updateStatus(branchId, id, body.status);
  }

  // --- Goods receipts (GRN) -----------------------------------------------------

  @Auth('inventory.manage')
  @Get('goods-receipts')
  async listGoodsReceipts(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.goodsReceiptsService.listGoodsReceipts(branchId);
  }

  @Auth('inventory.manage')
  @Get('goods-receipts/:id')
  async getGoodsReceipt(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.goodsReceiptsService.getGoodsReceipt(branchId, id);
  }

  @Auth('inventory.manage')
  @Post('goods-receipts')
  @UsePipes(new ZodValidationPipe(goodsReceiptSchema))
  async createGoodsReceipt(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.goodsReceiptsService.createGoodsReceipt(
      branchId,
      user.id,
      body as never,
    );
  }

  // --- Waste -----------------------------------------------------------------------

  @Auth('inventory.manage')
  @Get('waste')
  async listWasteLogs(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.wasteService.listWasteLogs(branchId);
  }

  @Auth('inventory.manage')
  @Post('waste')
  @UsePipes(new ZodValidationPipe(wasteLogSchema))
  async logWaste(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.wasteService.logWaste(branchId, user.id, body as never);
  }

  // --- Physical count, yield, prep batches, PPV -----------------------------------

  @Auth('inventory.manage')
  @Get('yield')
  async yieldReport(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryDepthService.yieldReport(branchId, from, to);
  }

  @Auth('inventory.manage')
  @Get('forecasts')
  async listForecasts(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.forecastService.list(branchId);
  }

  @Auth('inventory.manage')
  @Post('forecasts')
  async generateForecast(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.forecastService.generate(branchId, user.id);
  }

  @Auth('inventory.manage')
  @Get('forecasts/:id')
  async getForecast(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.forecastService.get(branchId, id);
  }

  @Auth('inventory.manage')
  @Post('forecasts/:id/apply-reorders')
  async applyForecastReorders(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.forecastService.applyReorders(branchId, user.id, id);
  }

  @Auth('inventory.manage')
  @Get('price-variance')
  async priceVariance(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('ingredientId') ingredientId?: string,
    @Query('supplierId') supplierId?: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryDepthService.priceVariance(
      branchId,
      from,
      to,
      ingredientId,
      supplierId,
    );
  }

  @Auth('inventory.manage')
  @Get('stock-counts')
  async listStockCounts(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.stockCountsService.list(branchId);
  }

  @Auth('inventory.manage')
  @Post('stock-counts')
  @UsePipes(new ZodValidationPipe(stockCountSchema))
  async createStockCount(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.stockCountsService.create(branchId, user.id, body as never);
  }

  @Auth('inventory.manage')
  @Get('stock-counts/:id')
  async getStockCount(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.stockCountsService.get(branchId, id);
  }

  @Auth('inventory.manage')
  @Post('stock-counts/:id/post')
  async postStockCount(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.stockCountsService.post(branchId, user.id, id);
  }

  @Auth('inventory.manage')
  @Get('prep-recipes')
  async listPrepRecipes(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.prepService.listRecipes(branchId);
  }

  @Auth('inventory.manage')
  @Post('prep-recipes')
  @UsePipes(new ZodValidationPipe(prepRecipeSchema))
  async createPrepRecipe(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.prepService.createRecipe(branchId, body as never);
  }

  @Auth('inventory.manage')
  @Get('prep-recipes/:id')
  async getPrepRecipe(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.prepService.getRecipe(branchId, id);
  }

  @Auth('inventory.manage')
  @Patch('prep-recipes/:id')
  @UsePipes(new ZodValidationPipe(prepRecipeSchema))
  async updatePrepRecipe(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.prepService.updateRecipe(branchId, id, body as never);
  }

  @Auth('inventory.manage')
  @Delete('prep-recipes/:id')
  async deletePrepRecipe(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.prepService.deleteRecipe(branchId, id);
  }

  @Auth('inventory.manage')
  @Get('prep-batches')
  async listPrepBatches(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.prepService.listBatches(branchId);
  }

  @Auth('inventory.manage')
  @Post('prep-batches')
  @UsePipes(new ZodValidationPipe(prepBatchSchema))
  async recordPrepBatch(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.prepService.recordBatch(branchId, user.id, body as never);
  }

  @Auth('inventory.manage')
  @Get('prep-batches/:id')
  async getPrepBatch(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.prepService.getBatch(branchId, id);
  }

  // --- Purchase requests ----------------------------------------------------------

  @Auth('inventory.manage')
  @Get('purchase-requests')
  async listPurchaseRequests(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('status') status?: PurchaseRequestStatus,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.purchaseRequestsService.listPurchaseRequests(branchId, status);
  }

  @Auth('inventory.manage')
  @Get('purchase-requests/:id')
  async getPurchaseRequest(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.purchaseRequestsService.getPurchaseRequest(branchId, id);
  }

  @Auth('inventory.manage')
  @Post('purchase-requests')
  @UsePipes(new ZodValidationPipe(purchaseRequestSchema))
  async createPurchaseRequest(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.purchaseRequestsService.createPurchaseRequest(
      branchId,
      user.id,
      body as never,
    );
  }

  @Auth('inventory.manage')
  @Patch('purchase-requests/:id/status')
  async updatePurchaseRequestStatus(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { status: PurchaseRequestStatus },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.purchaseRequestsService.updateStatus(
      branchId,
      id,
      user.id,
      body.status,
    );
  }

  // --- Supplier quotations ---------------------------------------------------------

  @Auth('inventory.manage')
  @Get('quotations')
  async listQuotations(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('ingredientId') ingredientId?: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.supplierQuotationsService.listQuotations(
      branchId,
      ingredientId,
    );
  }

  @Auth('inventory.manage')
  @Get('quotations/compare')
  async compareQuotations(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('ingredientId') ingredientId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.supplierQuotationsService.compareForIngredient(
      branchId,
      ingredientId,
    );
  }

  @Auth('inventory.manage')
  @Get('quotations/:id')
  async getQuotation(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.supplierQuotationsService.getQuotation(branchId, id);
  }

  @Auth('inventory.manage')
  @Post('quotations')
  @UsePipes(new ZodValidationPipe(supplierQuotationSchema))
  async createQuotation(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.supplierQuotationsService.createQuotation(
      branchId,
      user.id,
      body as never,
    );
  }

  @Auth('inventory.manage')
  @Patch('quotations/:id/status')
  async updateQuotationStatus(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { status: QuotationStatus },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.supplierQuotationsService.updateStatus(
      branchId,
      id,
      body.status,
    );
  }

  // --- Supplier invoices & payments -------------------------------------------------

  @Auth('inventory.manage')
  @Get('supplier-invoices')
  async listSupplierInvoices(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('supplierId') supplierId?: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.supplierInvoicesService.listInvoices(branchId, supplierId);
  }

  @Auth('inventory.manage')
  @Get('supplier-invoices/:id')
  async getSupplierInvoice(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.supplierInvoicesService.getInvoice(branchId, id);
  }

  @Auth('inventory.manage')
  @Post('supplier-invoices')
  @UsePipes(new ZodValidationPipe(supplierInvoiceSchema))
  async createSupplierInvoice(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.supplierInvoicesService.createInvoice(
      branchId,
      user.id,
      body as never,
    );
  }

  @Auth('inventory.manage')
  @Post('supplier-invoices/:id/payments')
  @UsePipes(new ZodValidationPipe(supplierPaymentSchema))
  async recordSupplierPayment(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.supplierInvoicesService.recordPayment(
      branchId,
      id,
      user.id,
      body as never,
    );
  }

  @Auth('inventory.manage')
  @Patch('supplier-invoices/:id/cancel')
  async cancelSupplierInvoice(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.supplierInvoicesService.cancelInvoice(branchId, id);
  }

  @Auth('inventory.manage')
  @Post('purchase-returns')
  @UsePipes(new ZodValidationPipe(purchaseReturnSchema))
  async createPurchaseReturn(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.inventoryService.createPurchaseReturn(
      branchId,
      user.id,
      body as never,
    );
  }

  @Auth('inventory.manage')
  @Get('suppliers/:id/performance')
  async getSupplierPerformance(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.supplierInvoicesService.getSupplierPerformance(branchId, id);
  }
}
