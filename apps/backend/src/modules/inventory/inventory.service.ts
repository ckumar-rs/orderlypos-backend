import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  IngredientDto,
  PurchaseReturnDto,
  SupplierDto,
  SetRecipeDto,
  MenuItemTrackingDto,
} from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';
import { round2, round3, round4 } from '../../common/money';
import { EmailService } from '../email/email.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { StockService } from './stock.service';
import { planStockUsage, type PlanItem, type StockPlan } from './stock-plan';
import { recipeCost } from './recipe-cost';
import { activeRevision, revisionStockLines } from './recipe-revision';
import { convertQuantity, type ConversionRow } from './unit-convert';

type Tx = Prisma.TransactionClient;

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stockService: StockService,
    private readonly purchaseOrders: PurchaseOrdersService,
    private readonly email: EmailService,
  ) {}

  // --- Ingredients ----------------------------------------------------------

  listIngredients(branchId: string) {
    return this.prisma.ingredient.findMany({
      where: { branchId },
      orderBy: { name: 'asc' },
    });
  }

  async getIngredient(branchId: string, id: string) {
    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id, branchId },
    });
    if (!ingredient) throw new NotFoundException('Ingredient not found');
    return ingredient;
  }

  createIngredient(branchId: string, dto: IngredientDto) {
    return this.prisma.ingredient.create({ data: { ...dto, branchId } });
  }

  async updateIngredient(
    branchId: string,
    id: string,
    dto: Partial<IngredientDto>,
  ) {
    await this.getIngredient(branchId, id);
    return this.prisma.ingredient.update({ where: { id }, data: dto });
  }

  async deleteIngredient(branchId: string, id: string) {
    await this.getIngredient(branchId, id);
    const usedInRecipe = await this.prisma.recipeIngredient.count({
      where: { ingredientId: id },
    });
    if (usedInRecipe > 0) {
      throw new BadRequestException(
        'Ingredient is used in a menu item recipe — remove it from every recipe first',
      );
    }
    await this.prisma.ingredient.delete({ where: { id } });
    return { ok: true };
  }

  async lowStockIngredients(branchId: string) {
    const ingredients = await this.listIngredients(branchId);
    return ingredients.filter(
      (i) => Number(i.currentStock) <= Number(i.reorderLevel),
    );
  }

  // --- Suppliers --------------------------------------------------------------

  listSuppliers(branchId: string) {
    return this.prisma.supplier.findMany({
      where: { branchId },
      orderBy: { name: 'asc' },
    });
  }

  async getSupplier(branchId: string, id: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id, branchId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  createSupplier(branchId: string, dto: SupplierDto) {
    return this.prisma.supplier.create({ data: { ...dto, branchId } });
  }

  async updateSupplier(
    branchId: string,
    id: string,
    dto: Partial<SupplierDto>,
  ) {
    await this.getSupplier(branchId, id);
    return this.prisma.supplier.update({ where: { id }, data: dto });
  }

  async deleteSupplier(branchId: string, id: string) {
    await this.getSupplier(branchId, id);
    const usedInPo = await this.prisma.purchaseOrder.count({
      where: { supplierId: id },
    });
    if (usedInPo > 0) {
      throw new BadRequestException(
        'Supplier has purchase orders on record — deactivate instead of deleting',
      );
    }
    await this.prisma.supplier.delete({ where: { id } });
    return { ok: true };
  }

  // --- Recipe costing -----------------------------------------------------------
  //
  // costPerUnit on Ingredient is a weighted-average, kept current by
  // GoodsReceiptsService on every GRN — so recipe cost here is always a
  // live, accurate read, not a stale snapshot recomputed on a timer.

  async getRecipe(branchId: string, menuItemId: string) {
    const item = await this.prisma.menuItem.findFirst({
      where: { id: menuItemId, branchId },
    });
    if (!item) throw new NotFoundException('Menu item not found');
    const [lines, custom] = await Promise.all([
      this.prisma.recipeIngredient.findMany({
        where: { menuItemId },
        include: { ingredient: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.conversionRows(branchId),
    ]);
    const costed = lines.map((line) => {
      const unit = line.unit ?? line.ingredient.unit;
      const stockQuantity = this.toStockQuantity(Number(line.quantity), unit, line.ingredient.unit, custom);
      return {
        id: line.id,
        ingredientId: line.ingredientId,
        ingredientName: line.ingredient.name,
        unit,
        quantity: Number(line.quantity),
        stockUnit: line.ingredient.unit,
        stockQuantity,
        costPerUnit: Number(line.ingredient.costPerUnit),
        lineCost: round2(stockQuantity * Number(line.ingredient.costPerUnit)),
      };
    });
    const cost = recipeCost(
      costed.map((line) => ({ quantity: line.stockQuantity, costPerUnit: line.costPerUnit })),
      item.servings,
      item.yieldQuantity == null ? null : Number(item.yieldQuantity),
    );
    return {
      lines: costed,
      totalCost: cost.perServing,
      batchCost: cost.batchCost,
      perServing: cost.perServing,
      perYield: cost.perYield,
      servings: item.servings,
      yieldQuantity: item.yieldQuantity == null ? null : Number(item.yieldQuantity),
      yieldUnit: item.yieldUnit,
      instructions: item.instructions,
      portionStep: Number(item.portionStep),
    };
  }

  async setRecipe(branchId: string, menuItemId: string, dto: SetRecipeDto) {
    const item = await this.prisma.menuItem.findFirst({
      where: { id: menuItemId, branchId },
    });
    if (!item) throw new NotFoundException('Menu item not found');
    const lines = dto.lines;

    const ingredientIds = lines.map((l) => l.ingredientId);
    if (new Set(ingredientIds).size !== ingredientIds.length) {
      throw new BadRequestException('Duplicate ingredient in recipe');
    }
    const ingredients =
      ingredientIds.length === 0
        ? []
        : await this.prisma.ingredient.findMany({
            where: { id: { in: ingredientIds }, branchId },
          });
    if (ingredients.length !== ingredientIds.length) {
      throw new BadRequestException('One or more ingredients not found in this branch');
    }
    const byId = new Map(ingredients.map((row) => [row.id, row]));
    const custom = await this.conversionRows(branchId);
    const snapshot = lines.map((line) => {
      const ingredient = byId.get(line.ingredientId)!;
      const unit = line.unit ?? ingredient.unit;
      const stockQuantity = convertQuantity(line.quantity, unit, ingredient.unit, custom);
      if (stockQuantity == null) {
        throw new BadRequestException(
          `Cannot convert ${unit} to ${ingredient.unit} for ${ingredient.name}. Add that conversion first.`,
        );
      }
      return {
        ingredientId: ingredient.id,
        name: ingredient.name,
        quantity: line.quantity,
        unit,
        stockQuantity,
        stockUnit: ingredient.unit,
      };
    });

    const servings = dto.servings ?? item.servings;
    const yieldQuantity = dto.yieldQuantity === undefined ? item.yieldQuantity : dto.yieldQuantity;
    const yieldUnit = dto.yieldUnit === undefined ? item.yieldUnit : dto.yieldUnit;
    const instructions = dto.instructions === undefined ? item.instructions : dto.instructions;
    const portionStep = dto.portionStep ?? Number(item.portionStep);
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date();
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new BadRequestException('Effective date is not valid');
    }
    const scheduled = effectiveFrom.getTime() > Date.now();
    const cost = recipeCost(
      snapshot.map((line) => ({
        quantity: line.stockQuantity,
        costPerUnit: Number(byId.get(line.ingredientId)!.costPerUnit),
      })),
      servings,
      yieldQuantity == null ? null : Number(yieldQuantity),
    );

    await this.prisma.$transaction(async (tx) => {
      if (!scheduled) {
      await tx.recipeIngredient.deleteMany({ where: { menuItemId } });
      if (snapshot.length > 0) {
        await tx.recipeIngredient.createMany({
          data: snapshot.map((line) => ({
            menuItemId,
            ingredientId: line.ingredientId,
            quantity: line.quantity,
            unit: line.unit as never,
          })),
        });
      }
      await tx.menuItem.update({
        where: { id: menuItemId },
        data: {
          costPrice: cost.perServing,
          servings,
          yieldQuantity,
          yieldUnit,
          instructions,
          portionStep,
          ...(snapshot.length > 0 && item.inventoryTracking === 'NONE'
            ? { inventoryTracking: 'RECIPE' }
            : {}),
        },
      });
      }
      await tx.recipeRevision.create({
        data: {
          menuItemId,
          foodCost: cost.perServing,
          sellingPrice: item.price,
          note: scheduled ? 'Scheduled recipe' : 'Recipe saved',
          servings,
          yieldQuantity,
          yieldUnit,
          instructions,
          lines: snapshot,
          effectiveFrom,
        },
      });
    });

    return this.getRecipe(branchId, menuItemId);
  }

  async getTracking(branchId: string, menuItemId: string) {
    const item = await this.prisma.menuItem.findFirst({
      where: { id: menuItemId, branchId },
      select: {
        id: true,
        inventoryTracking: true,
        stockIngredientId: true,
        stockQuantityPerSale: true,
        isCombo: true,
      },
    });
    if (!item) throw new NotFoundException('Menu item not found');
    return {
      ...item,
      stockQuantityPerSale: Number(item.stockQuantityPerSale),
    };
  }

  async setTracking(
    branchId: string,
    menuItemId: string,
    dto: MenuItemTrackingDto,
  ) {
    await this.assertMenuItemInBranch(branchId, menuItemId);
    if (dto.inventoryTracking === 'DIRECT') {
      const ingredient = await this.prisma.ingredient.findFirst({
        where: { id: dto.stockIngredientId ?? '', branchId },
        select: { id: true },
      });
      if (!ingredient) {
        throw new BadRequestException('Stock item not found in this branch');
      }
    }
    await this.prisma.menuItem.update({
      where: { id: menuItemId },
      data: {
        inventoryTracking: dto.inventoryTracking,
        stockIngredientId:
          dto.inventoryTracking === 'DIRECT' ? dto.stockIngredientId : null,
        stockQuantityPerSale:
          dto.inventoryTracking === 'DIRECT'
            ? (dto.stockQuantityPerSale ?? 1)
            : 1,
      },
    });
    return this.getTracking(branchId, menuItemId);
  }

  private async assertMenuItemInBranch(branchId: string, menuItemId: string) {
    const item = await this.prisma.menuItem.findFirst({
      where: { id: menuItemId, branchId },
      select: { id: true },
    });
    if (!item) throw new NotFoundException('Menu item not found');
  }

  // --- Automatic deduction on order checkout ------------------------------
  //
  // Called from OrdersService.checkout() inside its own transaction (`tx`
  // passed through, not opened here), so the movements, the ingredient
  // balances and the OPEN->PAID order update commit or roll back together.
  // What moves is decided by planStockUsage(): RECIPE items deduct their
  // recipe lines, DIRECT items deduct one stock item, NONE items nothing,
  // combos expand into their components. Stock may go negative on purpose
  // (allowNegative): a shortage must never block a paid sale, it shows up as
  // a negative balance for the next stocktake. Tracked items that cannot be
  // mapped to stock are returned in `skipped` and reported by the caller -
  // never silently ignored.
  //
  // Idempotent per order: checkout's guarded status update already makes
  // double-payment impossible; the CONSUMPTION lookup is a second line of
  // defence against any retry path re-running this for the same order.
  async deductForOrder(
    tx: Tx,
    branchId: string,
    userId: string,
    orderId: string,
    lines: { menuItemId: string; quantity: number }[],
  ): Promise<{ skipped: StockPlan['skipped'] }> {
    if (lines.length === 0) return { skipped: [] };
    const already = await tx.stockMovement.count({
      where: { orderId, type: 'CONSUMPTION' },
    });
    if (already > 0) return { skipped: [] };

    const plan = await this.planFor(tx, branchId, lines);
    for (const [ingredientId, quantity] of plan.needs) {
      if (quantity <= 0) continue;
      await this.stockService.consumeStock(
        tx,
        branchId,
        ingredientId,
        quantity,
        {
          type: 'CONSUMPTION',
          note: 'Order checkout',
          userId,
          allowNegative: true,
          orderId,
        },
      );
    }
    return { skipped: plan.skipped };
  }

  // Puts physically returned units back in stock (compensating REVERSAL
  // movements). Only called when a refund explicitly names the returned
  // items; a money-only refund never reaches here.
  async restoreForReturn(
    tx: Tx,
    branchId: string,
    userId: string,
    orderId: string,
    lines: { menuItemId: string; quantity: number }[],
  ): Promise<{ restored: number }> {
    const plan = await this.planFor(tx, branchId, lines);
    let restored = 0;
    for (const [ingredientId, quantity] of plan.needs) {
      restored += await this.stockService.restoreStock(
        tx,
        branchId,
        ingredientId,
        quantity,
        { userId, orderId, note: 'Returned with refund' },
      );
    }
    return { restored };
  }

  private async planFor(
    tx: Tx,
    branchId: string,
    lines: { menuItemId: string; quantity: number }[],
  ): Promise<StockPlan> {
    const ids = [...new Set(lines.map((l) => l.menuItemId))];
    const combos = await tx.comboComponent.findMany({
      where: { comboItemId: { in: ids } },
    });
    const allIds = [
      ...new Set([...ids, ...combos.map((c) => c.componentItemId)]),
    ];
    const [rows, conversions, revisions] = await Promise.all([
      tx.menuItem.findMany({
        where: { id: { in: allIds } },
        include: { recipeLines: { include: { ingredient: { select: { unit: true, costPerUnit: true } } } } },
      }),
      tx.unitConversion.findMany({ where: { branchId } }),
      tx.recipeRevision.findMany({
        where: { menuItemId: { in: allIds } },
        select: { id: true, menuItemId: true, effectiveFrom: true, createdAt: true, servings: true, lines: true },
      }),
    ]);
    const revisionsByItem = new Map<string, typeof revisions>();
    for (const revision of revisions) {
      const list = revisionsByItem.get(revision.menuItemId) ?? [];
      list.push(revision);
      revisionsByItem.set(revision.menuItemId, list);
    }
    const custom: ConversionRow[] = conversions.map((row) => ({
      fromUnit: row.fromUnit,
      toUnit: row.toUnit,
      factor: Number(row.factor),
    }));
    const items = new Map<string, PlanItem>(
      rows.map((m) => [
        m.id,
        {
          id: m.id,
          name: m.name,
          isCombo: m.isCombo,
          tracking: m.inventoryTracking,
          stockIngredientId: m.stockIngredientId,
          stockQuantityPerSale: Number(m.stockQuantityPerSale),
          recipe: this.recipeForCheckout(m, revisionsByItem.get(m.id) ?? [], custom),
        },
      ]),
    );
    return planStockUsage(lines, items, combos);
  }

  // Setup status: sellable items whose inventory tracking is switched on but
  // not mapped to any stock, so selling them would deduct nothing.
  async trackingSetupStatus(branchId: string) {
    const items = await this.prisma.menuItem.findMany({
      where: {
        branchId,
        isActive: true,
        isCombo: false,
        inventoryTracking: { not: 'NONE' },
      },
      select: {
        id: true,
        name: true,
        inventoryTracking: true,
        stockIngredientId: true,
        stockQuantityPerSale: true,
        _count: { select: { recipeLines: true } },
      },
      orderBy: { name: 'asc' },
    });
    const problems = items.flatMap<StockPlan['skipped'][number]>((i) => {
      if (i.inventoryTracking === 'RECIPE' && i._count.recipeLines === 0) {
        return [
          { menuItemId: i.id, name: i.name, reason: 'NO_RECIPE' as const },
        ];
      }
      if (
        i.inventoryTracking === 'DIRECT' &&
        (!i.stockIngredientId || Number(i.stockQuantityPerSale) <= 0)
      ) {
        return [
          { menuItemId: i.id, name: i.name, reason: 'NO_STOCK_ITEM' as const },
        ];
      }
      return [];
    });
    const [untracked, tracked] = await Promise.all([
      this.prisma.menuItem.count({
        where: {
          branchId,
          isActive: true,
          isCombo: false,
          inventoryTracking: 'NONE',
        },
      }),
      this.prisma.menuItem.count({
        where: {
          branchId,
          isActive: true,
          isCombo: false,
          inventoryTracking: { not: 'NONE' },
        },
      }),
    ]);
    return { tracked, untracked, problems };
  }

  /**
   * Opens or extends one draft purchase request for ingredients at or below
   * their reorder level. A sale is never failed if this bookkeeping fails.
   */
  async suggestReorders(branchId: string, userId: string): Promise<number> {
    const ingredients = await this.prisma.ingredient.findMany({
      where: { branchId, isActive: true },
    });
    const low = ingredients.filter(
      (ingredient) =>
        Number(ingredient.reorderLevel) > 0 &&
        Number(ingredient.currentStock) <= Number(ingredient.reorderLevel),
    );
    if (low.length === 0) return 0;

    const draft = await this.prisma.purchaseRequest.findFirst({
      where: { branchId, status: 'DRAFT', notes: 'Automatic reorder' },
      include: { items: true },
    });
    const missing = low.filter(
      (ingredient) =>
        !draft?.items.some((item) => item.ingredientId === ingredient.id),
    );
    if (missing.length === 0) return 0;

    const rows = missing.map((ingredient) => {
      const level = Number(ingredient.reorderLevel);
      const stock = Math.max(Number(ingredient.currentStock), 0);
      return {
        ingredientId: ingredient.id,
        quantityRequested: round3(Math.max(level, level * 2 - stock)),
        notes: 'Stock is at or below the reorder level',
      };
    });

    if (!draft) {
      const count = await this.prisma.purchaseRequest.count({
        where: { branchId },
      });
      await this.prisma.purchaseRequest.create({
        data: {
          branchId,
          requestNumber: `PR-${String(count + 1).padStart(4, '0')}`,
          notes: 'Automatic reorder',
          requestedById: userId,
          items: { create: rows },
        },
      });
    } else {
      await this.prisma.purchaseRequestItem.createMany({
        data: rows.map((row) => ({
          purchaseRequestId: draft.id,
          ...row,
        })),
      });
    }
    await this.placeReorder(branchId, userId, missing);
    return rows.length;
  }

  /** Demo mode writes a draft. Otherwise the order is emailed and marked sent. */
  private async placeReorder(
    branchId: string,
    userId: string,
    ingredients: {
      id: string;
      name: string;
      costPerUnit: { toString(): string };
      reorderLevel: { toString(): string };
      currentStock: { toString(): string };
      purchaseToBase: { toString(): string };
    }[],
  ) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { restaurant: { select: { demoMode: true } } },
    });
    const items = ingredients.map((ingredient) => {
      const factor = Number(ingredient.purchaseToBase) || 1;
      const level = Number(ingredient.reorderLevel);
      const stock = Math.max(Number(ingredient.currentStock), 0);
      const stockQty = round3(Math.max(level, level * 2 - stock));
      return {
        ingredientId: ingredient.id,
        quantityOrdered: round3(stockQty / factor),
        unitCost: round4(Number(ingredient.costPerUnit) * factor),
      };
    });
    if (branch?.restaurant.demoMode) {
      await this.createDemoPurchaseOrder(branchId, userId, items);
      return;
    }
    let supplier = await this.prisma.supplier.findFirst({
      where: { branchId, isActive: true, email: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    if (!supplier) {
      supplier = await this.prisma.supplier.findFirst({
        where: { branchId, isActive: true },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (!supplier) return;
    try {
      const po = await this.purchaseOrders.createPurchaseOrder(branchId, userId, {
        supplierId: supplier.id,
        notes: 'Automatic reorder',
        items,
      });
      await this.purchaseOrders.updateStatus(branchId, po.id, 'SENT');
    } catch (err) {
      this.logger.warn(
        `Reorder for branch ${branchId} stayed a draft: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Demo mode only: a draft purchase order. No supplier is contacted. */
  private async createDemoPurchaseOrder(
    branchId: string,
    userId: string,
    items: { ingredientId: string; quantityOrdered: number; unitCost: number }[],
  ) {
    let supplier = await this.prisma.supplier.findFirst({
      where: { branchId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!supplier) {
      supplier = await this.prisma.supplier.create({
        data: {
          branchId,
          name: 'Demo supplier',
          notes: 'Created for a demo reorder. No real order was sent.',
        },
      });
    }
    const count = await this.prisma.purchaseOrder.count({ where: { branchId } });
    const totalAmount = round2(
      items.reduce((sum, item) => sum + item.quantityOrdered * item.unitCost, 0),
    );
    await this.prisma.purchaseOrder.create({
      data: {
        branchId,
        supplierId: supplier.id,
        poNumber: `PO-DEMO-${String(count + 1).padStart(4, '0')}`,
        notes: 'Demo purchase order from an automatic reorder. Not sent to a supplier.',
        totalAmount,
        createdById: userId,
        items: { create: items },
      },
    }).catch(() => undefined);
  }

  async createPurchaseReturn(
    branchId: string,
    userId: string,
    dto: PurchaseReturnDto,
  ) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, branchId },
    });
    if (!supplier) throw new BadRequestException('Supplier not found in this branch');
    const ids = [...new Set(dto.items.map((item) => item.ingredientId))];
    const ingredients = await this.prisma.ingredient.findMany({
      where: { id: { in: ids }, branchId },
    });
    if (ingredients.length !== ids.length) {
      throw new BadRequestException('One or more ingredients were not found');
    }
    const names = new Map(ingredients.map((row) => [row.id, row.name]));
    const created = await this.prisma.$transaction(async (tx) => {
      for (const item of dto.items) {
        await this.stockService.consumeStock(
          tx,
          branchId,
          item.ingredientId,
          item.quantity,
          {
            type: 'ADJUSTMENT',
            note: `Purchase return: ${dto.reason}`,
            userId,
            allowNegative: false,
          },
        );
      }
      return tx.purchaseReturn.create({
        data: {
          branchId,
          supplierId: supplier.id,
          reason: dto.reason,
          createdById: userId,
          items: {
            create: dto.items.map((item) => ({
              ingredientId: item.ingredientId,
              quantity: item.quantity,
            })),
          },
        },
        include: { items: true },
      });
    });
    let emailed = false;
    const to = supplier.email?.trim();
    if (to && this.email.isConfigured()) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { restaurant: { select: { demoMode: true, name: true } } },
      });
      if (!branch?.restaurant.demoMode) {
        const lines = dto.items
          .map((item) => `${names.get(item.ingredientId) ?? item.ingredientId}: ${item.quantity}`)
          .join('\n');
        try {
          await this.email.send({
            to,
            subject: `Purchase return from ${branch?.restaurant.name ?? 'the restaurant'}`,
            text: `${dto.reason}\n\n${lines}`,
          });
          emailed = true;
          await this.prisma.purchaseReturn.update({
            where: { id: created.id },
            data: { emailed: true },
          });
        } catch (err) {
          this.logger.warn(
            `Purchase return ${created.id} was saved but not emailed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return { ...created, emailed };
  }

  private async conversionRows(branchId: string): Promise<ConversionRow[]> {
    const rows = await this.prisma.unitConversion.findMany({ where: { branchId } });
    return rows.map((row) => ({
      fromUnit: row.fromUnit,
      toUnit: row.toUnit,
      factor: Number(row.factor),
    }));
  }

  private toStockQuantity(quantity: number, fromUnit: string, toUnit: string, custom: ConversionRow[]) {
    return convertQuantity(quantity, fromUnit, toUnit, custom) ?? quantity;
  }

  private recipeForCheckout(
    item: {
      servings: number;
      recipeLines: Array<{
        ingredientId: string;
        quantity: unknown;
        unit: string | null;
        ingredient: { unit: string };
      }>;
    },
    revisions: Array<{ effectiveFrom: Date; createdAt: Date; servings: number; lines: unknown }>,
    custom: ConversionRow[],
  ) {
    const active = activeRevision(revisions, new Date());
    const stock = revisionStockLines(active?.lines);
    if (active && stock.length > 0) {
      const servings = Math.max(1, active.servings);
      return stock.map((line) => ({
        ingredientId: line.ingredientId,
        quantity: line.stockQuantity / servings,
      }));
    }
    return item.recipeLines.map((line) => ({
      ingredientId: line.ingredientId,
      quantity:
        this.toStockQuantity(
          Number(line.quantity),
          line.unit ?? line.ingredient.unit,
          line.ingredient.unit,
          custom,
        ) / Math.max(1, item.servings),
    }));
  }
}
