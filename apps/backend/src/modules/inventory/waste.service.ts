import { Injectable, NotFoundException } from '@nestjs/common';
import type { WasteLogDto } from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';
import { StockService } from './stock.service';

@Injectable()
export class WasteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockService: StockService,
  ) {}

  listWasteLogs(branchId: string) {
    return this.prisma.wasteLog.findMany({
      where: { branchId },
      include: {
        ingredient: { select: { id: true, name: true, unit: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // FIFO-consumes via StockService.consumeStock (blocks over-consumption —
  // waste can't exceed what's actually on hand), then records one WasteLog
  // row per batch portion touched, each carrying that portion's own cost —
  // an accurate cost-of-waste figure, not a blended average that hides
  // which lot actually spoiled.
  async logWaste(branchId: string, userId: string, dto: WasteLogDto) {
    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id: dto.ingredientId, branchId },
    });
    if (!ingredient) throw new NotFoundException('Ingredient not found');

    return this.prisma.$transaction(async (tx) => {
      const portions = await this.stockService.consumeStock(
        tx,
        branchId,
        dto.ingredientId,
        dto.quantity,
        { type: 'WASTE', note: dto.notes, userId, allowNegative: false },
      );

      const logs: Awaited<ReturnType<typeof tx.wasteLog.create>>[] = [];
      for (const portion of portions) {
        logs.push(
          await tx.wasteLog.create({
            data: {
              branchId,
              ingredientId: dto.ingredientId,
              batchId: portion.batchId,
              quantity: portion.quantity,
              reason: dto.reason,
              unitCostAtWaste: portion.unitCost,
              notes: dto.notes,
              createdById: userId,
            },
          }),
        );
      }
      return logs;
    });
  }
}
