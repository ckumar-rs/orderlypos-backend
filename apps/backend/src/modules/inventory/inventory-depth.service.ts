import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { computePpvLine, computeYieldRow, periodBounds } from './inventory-depth';

@Injectable()
export class InventoryDepthService {
  constructor(private readonly prisma: PrismaService) {}

  async yieldReport(branchId: string, from?: string, to?: string) {
    let start: Date;
    let end: Date;
    try {
      ({ start, end } = periodBounds(from, to));
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid dates',
      );
    }

    const ingredients = await this.prisma.ingredient.findMany({
      where: { branchId },
      select: {
        id: true,
        name: true,
        unit: true,
        costPerUnit: true,
        currentStock: true,
      },
      orderBy: { name: 'asc' },
    });
    const movements = await this.prisma.stockMovement.findMany({
      where: { branchId, createdAt: { lte: end } },
      select: {
        ingredientId: true,
        type: true,
        quantity: true,
        createdAt: true,
      },
    });

    const rows = ingredients
      .map((ingredient) => {
        const all = movements.filter((m) => m.ingredientId === ingredient.id);
        const opening = sumQty(all.filter((m) => m.createdAt < start));
        const period = all.filter((m) => m.createdAt >= start);
        const receipts = sumQty(
          period.filter(
            (m) =>
              m.type === 'RECEIPT' ||
              (m.type === 'PRODUCTION' && Number(m.quantity) > 0),
          ),
        );
        const reversals = sumQty(period.filter((m) => m.type === 'REVERSAL'));
        const theoretical = absOut(
          period.filter((m) => m.type === 'CONSUMPTION'),
        );
        const productionOut = absOut(
          period.filter(
            (m) => m.type === 'PRODUCTION' && Number(m.quantity) < 0,
          ),
        );
        const waste = absOut(period.filter((m) => m.type === 'WASTE'));
        const closing = opening + sumQty(period);
        const row = computeYieldRow({
          opening,
          receipts,
          reversals,
          theoretical,
          productionOut,
          waste,
          closing,
          costPerUnit: Number(ingredient.costPerUnit),
        });
        return {
          ingredientId: ingredient.id,
          name: ingredient.name,
          unit: ingredient.unit,
          ...row,
        };
      })
      .filter(
        (row) =>
          row.opening !== 0 ||
          row.receipts !== 0 ||
          row.theoretical !== 0 ||
          row.productionOut !== 0 ||
          row.waste !== 0 ||
          row.closing !== 0 ||
          row.unexplained !== 0,
      );

    return {
      from: start.toISOString(),
      to: end.toISOString(),
      rows,
      totals: {
        theoretical: sum(rows.map((r) => r.theoretical)),
        actualUsage: sum(rows.map((r) => r.actualUsage)),
        waste: sum(rows.map((r) => r.waste)),
        unexplained: sum(rows.map((r) => r.unexplained)),
        wasteCost: sum(rows.map((r) => r.wasteCost)),
        unexplainedCost: sum(rows.map((r) => r.unexplainedCost)),
      },
    };
  }

  async priceVariance(
    branchId: string,
    from?: string,
    to?: string,
    ingredientId?: string,
    supplierId?: string,
  ) {
    let start: Date;
    let end: Date;
    try {
      ({ start, end } = periodBounds(from, to));
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid dates',
      );
    }

    const receipts = await this.prisma.goodsReceiptItem.findMany({
      where: {
        goodsReceipt: {
          branchId,
          receivedAt: { gte: start, lte: end },
          ...(supplierId ? { supplierId } : {}),
        },
        ...(ingredientId ? { ingredientId } : {}),
      },
      include: {
        ingredient: { select: { id: true, name: true, unit: true } },
        purchaseOrderItem: { select: { unitCost: true } },
        goodsReceipt: {
          select: {
            id: true,
            grnNumber: true,
            receivedAt: true,
            supplierId: true,
            supplier: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { goodsReceipt: { receivedAt: 'asc' } },
    });

    const quotes = await this.prisma.supplierQuotationItem.findMany({
      where: {
        supplierQuotation: {
          branchId,
          status: { in: ['RECEIVED', 'ACCEPTED'] },
          ...(supplierId ? { supplierId } : {}),
        },
        ...(ingredientId ? { ingredientId } : {}),
      },
      include: {
        supplierQuotation: {
          select: { supplierId: true, createdAt: true, validUntil: true },
        },
      },
      orderBy: { supplierQuotation: { createdAt: 'desc' } },
    });

    const lines = receipts.map((item) => {
      const actual = Number(item.unitCost);
      const po = item.purchaseOrderItem
        ? Number(item.purchaseOrderItem.unitCost)
        : null;
      const quoted = latestQuote(
        quotes,
        item.ingredientId,
        item.goodsReceipt.supplierId,
        item.goodsReceipt.receivedAt,
      );
      const ppv = computePpvLine(Number(item.quantity), actual, po, quoted);
      return {
        goodsReceiptItemId: item.id,
        grnNumber: item.goodsReceipt.grnNumber,
        receivedAt: item.goodsReceipt.receivedAt,
        ingredientId: item.ingredient.id,
        ingredientName: item.ingredient.name,
        unit: item.ingredient.unit,
        supplierId: item.goodsReceipt.supplier.id,
        supplierName: item.goodsReceipt.supplier.name,
        ...ppv,
      };
    });

    const byKey = new Map<
      string,
      {
        ingredientId: string;
        ingredientName: string;
        supplierId: string;
        supplierName: string;
        qty: number;
        spend: number;
        min: number;
        max: number;
        varianceVsPo: number;
        varianceVsQuote: number;
      }
    >();
    for (const line of lines) {
      const key = `${line.ingredientId}:${line.supplierId}`;
      const current = byKey.get(key) ?? {
        ingredientId: line.ingredientId,
        ingredientName: line.ingredientName,
        supplierId: line.supplierId,
        supplierName: line.supplierName,
        qty: 0,
        spend: 0,
        min: line.actual,
        max: line.actual,
        varianceVsPo: 0,
        varianceVsQuote: 0,
      };
      current.qty += line.qty;
      current.spend += line.qty * line.actual;
      current.min = Math.min(current.min, line.actual);
      current.max = Math.max(current.max, line.actual);
      current.varianceVsPo += line.varianceVsPo ?? 0;
      current.varianceVsQuote += line.varianceVsQuote ?? 0;
      byKey.set(key, current);
    }

    return {
      from: start.toISOString(),
      to: end.toISOString(),
      lines,
      summary: [...byKey.values()].map((row) => ({
        ...row,
        avg: row.qty > 0 ? row.spend / row.qty : 0,
      })),
    };
  }
}

function sumQty(rows: { quantity: unknown }[]) {
  return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
}

function absOut(rows: { quantity: unknown }[]) {
  return rows.reduce((sum, row) => sum + Math.abs(Number(row.quantity)), 0);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function latestQuote(
  quotes: {
    ingredientId: string;
    unitPrice: unknown;
    supplierQuotation: {
      supplierId: string;
      createdAt: Date;
      validUntil: Date | null;
    };
  }[],
  ingredientId: string,
  supplierId: string,
  receivedAt: Date,
) {
  const match = quotes.find((quote) => {
    if (quote.ingredientId !== ingredientId) return false;
    if (quote.supplierQuotation.supplierId !== supplierId) return false;
    if (quote.supplierQuotation.createdAt > receivedAt) return false;
    if (
      quote.supplierQuotation.validUntil &&
      quote.supplierQuotation.validUntil < receivedAt
    ) {
      return false;
    }
    return true;
  });
  return match ? Number(match.unitPrice) : null;
}
