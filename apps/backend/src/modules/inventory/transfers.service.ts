import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { round3, round4 } from '../../common/money';
import { StockService } from './stock.service';

@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  list(restaurantId: string, branchId: string) {
    return this.prisma.stockTransfer.findMany({
      where: {
        restaurantId,
        OR: [{ fromBranchId: branchId }, { toBranchId: branchId }],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** Branches of the restaurant a transfer can go to. */
  otherBranches(restaurantId: string, branchId: string) {
    return this.prisma.branch.findMany({
      where: { restaurantId, isActive: true, NOT: { id: branchId } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async transfer(
    restaurantId: string,
    userId: string,
    fromBranchId: string,
    dto: {
      toBranchId: string;
      ingredientId: string;
      quantity: number;
      note?: string;
    },
  ) {
    if (dto.toBranchId === fromBranchId)
      throw new BadRequestException('Pick a different destination branch');
    const [from, to] = await Promise.all([
      this.prisma.branch.findFirst({
        where: { id: fromBranchId, restaurantId },
        select: { id: true, name: true },
      }),
      this.prisma.branch.findFirst({
        where: { id: dto.toBranchId, restaurantId, isActive: true },
        select: { id: true, name: true },
      }),
    ]);
    if (!from || !to)
      throw new BadRequestException(
        'Both branches must belong to this restaurant',
      );
    const source = await this.prisma.ingredient.findFirst({
      where: { id: dto.ingredientId, branchId: fromBranchId },
    });
    if (!source)
      throw new BadRequestException('Ingredient not found in this branch');

    return this.prisma.$transaction(async (tx) => {
      const portions = await this.stock.consumeStock(
        tx,
        fromBranchId,
        source.id,
        dto.quantity,
        {
          type: 'ADJUSTMENT',
          note: `Transfer out to ${to.name}`,
          userId,
        },
      );
      const totalCost = portions.reduce(
        (s, p) => s + p.quantity * p.unitCost,
        0,
      );
      const unitCost = round4(totalCost / dto.quantity);

      // Same-named ingredient at the destination, created on first transfer.
      const dest =
        (await tx.ingredient.findFirst({
          where: { branchId: to.id, name: source.name },
        })) ??
        (await tx.ingredient.create({
          data: {
            branchId: to.id,
            name: source.name,
            sku: source.sku,
            unit: source.unit,
            reorderLevel: source.reorderLevel,
          },
        }));
      if (dest.unit !== source.unit)
        throw new BadRequestException(
          `${to.name} stocks ${source.name} in ${dest.unit}, not ${source.unit}`,
        );

      await tx.$queryRaw`SELECT id FROM ingredients WHERE id = ${dest.id} FOR UPDATE`;
      const fresh = await tx.ingredient.findUniqueOrThrow({
        where: { id: dest.id },
      });
      const batch = await tx.stockBatch.create({
        data: {
          branchId: to.id,
          ingredientId: dest.id,
          batchNumber: `TRF-${Date.now().toString(36).toUpperCase()}`,
          quantityReceived: dto.quantity,
          quantityRemaining: dto.quantity,
          unitCost,
        },
      });
      await tx.stockMovement.create({
        data: {
          branchId: to.id,
          ingredientId: dest.id,
          batchId: batch.id,
          type: 'RECEIPT',
          quantity: dto.quantity,
          note: `Transfer in from ${from.name}`,
          createdById: userId,
        },
      });
      // Weighted-average cost over the stock already on hand plus this batch.
      const oldQty = Math.max(0, Number(fresh.currentStock));
      const newQty = round3(oldQty + dto.quantity);
      const avg = round4(
        (oldQty * Number(fresh.costPerUnit) + dto.quantity * unitCost) / newQty,
      );
      await tx.ingredient.update({
        where: { id: dest.id },
        data: {
          currentStock: round3(Number(fresh.currentStock) + dto.quantity),
          costPerUnit: avg,
        },
      });

      return tx.stockTransfer.create({
        data: {
          restaurantId,
          fromBranchId,
          toBranchId: to.id,
          fromBranchName: from.name,
          toBranchName: to.name,
          ingredientName: source.name,
          unit: source.unit,
          quantity: dto.quantity,
          unitCost,
          note: dto.note,
          createdById: userId,
        },
      });
    });
  }
}
