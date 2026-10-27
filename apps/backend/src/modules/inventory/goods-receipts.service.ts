import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { GoodsReceiptDto } from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';
import { round3, round4 } from '../../common/money';

type PurchaseOrderWithItems = Prisma.PurchaseOrderGetPayload<{
  include: { items: true };
}>;

@Injectable()
export class GoodsReceiptsService {
  constructor(private readonly prisma: PrismaService) {}

  listGoodsReceipts(branchId: string) {
    return this.prisma.goodsReceipt.findMany({
      where: { branchId },
      include: {
        supplier: { select: { id: true, name: true } },
        items: true,
        receivedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getGoodsReceipt(branchId: string, id: string) {
    const grn = await this.prisma.goodsReceipt.findFirst({
      where: { id, branchId },
      include: {
        supplier: true,
        purchaseOrder: { select: { id: true, poNumber: true } },
        receivedBy: { select: { id: true, name: true } },
        items: { include: { ingredient: true, stockBatch: true } },
      },
    });
    if (!grn) throw new NotFoundException('Goods receipt not found');
    return grn;
  }

  // Creates the GRN, one StockBatch + StockMovement per line, updates each
  // Ingredient's cached currentStock/costPerUnit (weighted-average, read-
  // then-set — never a DB `increment`, see the schema comment for why), and
  // — if linked to a PO — the PO item's quantityReceived and the PO's
  // overall status. All in one transaction: a GRN is either fully applied
  // to stock or not applied at all, never half-way.
  async createGoodsReceipt(
    branchId: string,
    userId: string,
    dto: GoodsReceiptDto,
  ) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, branchId },
    });
    if (!supplier)
      throw new BadRequestException('Supplier not found in this branch');

    let purchaseOrder: PurchaseOrderWithItems | null = null;
    if (dto.purchaseOrderId) {
      purchaseOrder = await this.prisma.purchaseOrder.findFirst({
        where: { id: dto.purchaseOrderId, branchId },
        include: { items: true },
      });
      if (!purchaseOrder)
        throw new BadRequestException(
          'Purchase order not found in this branch',
        );
      if (
        purchaseOrder.status === 'CANCELLED' ||
        purchaseOrder.status === 'RECEIVED'
      ) {
        throw new BadRequestException(
          `Cannot receive against a purchase order that is already ${purchaseOrder.status}`,
        );
      }
    }

    const ingredientIds = dto.items.map((i) => i.ingredientId);
    const ingredients = await this.prisma.ingredient.findMany({
      where: { id: { in: ingredientIds }, branchId },
    });
    if (ingredients.length !== new Set(ingredientIds).size) {
      throw new BadRequestException(
        'One or more ingredients not found in this branch',
      );
    }

    // purchaseOrderItemId, if provided, must belong to this PO and this ingredient.
    if (purchaseOrder) {
      for (const item of dto.items) {
        if (!item.purchaseOrderItemId) continue;
        const poItem = purchaseOrder.items.find(
          (pi) => pi.id === item.purchaseOrderItemId,
        );
        if (!poItem || poItem.ingredientId !== item.ingredientId) {
          throw new BadRequestException(
            'purchaseOrderItemId does not match this purchase order / ingredient',
          );
        }
      }
    }

    const grnNumber = await this.nextGrnNumber(branchId);

    return this.prisma.$transaction(async (tx) => {
      const grn = await tx.goodsReceipt.create({
        data: {
          branchId,
          supplierId: dto.supplierId,
          purchaseOrderId: dto.purchaseOrderId,
          grnNumber,
          notes: dto.notes,
          receivedById: userId,
        },
      });

      // Accumulate per-PO-item received quantities in JS first, in case two
      // lines in the same GRN target the same purchaseOrderItemId — then
      // apply as a single `set` per item (never `increment`, same
      // no-float-drift discipline as the Ingredient cost/stock update below).
      const receivedByPoItem = new Map<string, number>();

      for (const [index, item] of dto.items.entries()) {
        const ingredient = ingredients.find((i) => i.id === item.ingredientId)!;
        const factor = Number(ingredient.purchaseToBase) || 1;
        const baseQty = round3(item.quantity * factor);
        const unitCostBase = factor > 0 ? item.unitCost / factor : item.unitCost;
        const batchNumber = item.batchNumber || `${grnNumber}-${index + 1}`;

        const grnItem = await tx.goodsReceiptItem.create({
          data: {
            goodsReceiptId: grn.id,
            ingredientId: item.ingredientId,
            purchaseOrderItemId: item.purchaseOrderItemId,
            quantity: item.quantity,
            unitCost: item.unitCost,
            batchNumber,
            expiryDate: item.expiryDate,
          },
        });

        const batch = await tx.stockBatch.create({
          data: {
            branchId,
            ingredientId: item.ingredientId,
            goodsReceiptItemId: grnItem.id,
            batchNumber,
            quantityReceived: baseQty,
            quantityRemaining: baseQty,
            unitCost: unitCostBase,
            expiryDate: item.expiryDate,
          },
        });

        await tx.stockMovement.create({
          data: {
            branchId,
            ingredientId: item.ingredientId,
            batchId: batch.id,
            type: 'RECEIPT',
            quantity: baseQty,
            note: `GRN ${grnNumber}`,
            createdById: userId,
          },
        });

        // Weighted-average cost, computed against the ingredient's stock as
        // of the START of this transaction — safe because Postgres holds a
        // row lock on this Ingredient for the rest of the transaction once
        // read via a transactional client, preventing a concurrent GRN on
        // the same ingredient from reading the same stale oldStock.
        const oldStock = Math.max(0, Number(ingredient.currentStock));
        const oldCost = Number(ingredient.costPerUnit);
        const newStock = round3(oldStock + baseQty);
        const newCost =
          newStock > 0
            ? round4((oldStock * oldCost + baseQty * unitCostBase) / newStock)
            : oldCost;

        await tx.ingredient.update({
          where: { id: item.ingredientId },
          data: { currentStock: newStock, costPerUnit: newCost },
        });
        // Keep the in-memory ingredient snapshot current for subsequent
        // lines in this same GRN referencing the same ingredient twice.
        ingredient.currentStock =
          newStock as unknown as typeof ingredient.currentStock;
        ingredient.costPerUnit =
          newCost as unknown as typeof ingredient.costPerUnit;

        if (item.purchaseOrderItemId) {
          receivedByPoItem.set(
            item.purchaseOrderItemId,
            (receivedByPoItem.get(item.purchaseOrderItemId) ?? 0) +
              item.quantity,
          );
        }
      }

      for (const [poItemId, addedQty] of receivedByPoItem) {
        const poItem = purchaseOrder!.items.find((pi) => pi.id === poItemId)!;
        await tx.purchaseOrderItem.update({
          where: { id: poItemId },
          data: {
            quantityReceived: round3(
              Number(poItem.quantityReceived) + addedQty,
            ),
          },
        });
      }

      if (purchaseOrder) {
        const items = await tx.purchaseOrderItem.findMany({
          where: { purchaseOrderId: purchaseOrder.id },
        });
        const fullyReceived = items.every(
          (i) => Number(i.quantityReceived) >= Number(i.quantityOrdered),
        );
        const anyReceived = items.some((i) => Number(i.quantityReceived) > 0);
        await tx.purchaseOrder.update({
          where: { id: purchaseOrder.id },
          data: {
            status: fullyReceived
              ? 'RECEIVED'
              : anyReceived
                ? 'PARTIALLY_RECEIVED'
                : purchaseOrder.status,
          },
        });
      }

      return tx.goodsReceipt.findUniqueOrThrow({
        where: { id: grn.id },
        include: { items: { include: { ingredient: true, stockBatch: true } } },
      });
    });
  }

  private async nextGrnNumber(branchId: string): Promise<string> {
    const count = await this.prisma.goodsReceipt.count({ where: { branchId } });
    return `GRN-${String(count + 1).padStart(4, '0')}`;
  }
}
