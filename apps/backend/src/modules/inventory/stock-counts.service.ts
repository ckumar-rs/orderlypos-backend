import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { StockCountDto } from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';
import { round3 } from '../../common/money';

const includeCount = {
  countedBy: { select: { id: true, name: true } },
  lines: {
    include: { ingredient: { select: { id: true, name: true, unit: true } } },
    orderBy: { ingredient: { name: 'asc' as const } },
  },
};

@Injectable()
export class StockCountsService {
  constructor(private readonly prisma: PrismaService) {}

  list(branchId: string) {
    return this.prisma.stockCount.findMany({
      where: { branchId },
      include: {
        countedBy: { select: { id: true, name: true } },
        _count: { select: { lines: true } },
      },
      orderBy: { countedAt: 'desc' },
    });
  }

  async get(branchId: string, id: string) {
    const count = await this.prisma.stockCount.findFirst({
      where: { id, branchId },
      include: includeCount,
    });
    if (!count) throw new NotFoundException('Stock count not found');
    return this.withVariance(count);
  }

  async create(branchId: string, userId: string, dto: StockCountDto) {
    const ids = [...new Set(dto.lines.map((line) => line.ingredientId))];
    if (ids.length !== dto.lines.length) {
      throw new BadRequestException('Each ingredient can appear once');
    }
    const ingredients = await this.prisma.ingredient.findMany({
      where: { id: { in: ids }, branchId },
    });
    if (ingredients.length !== ids.length) {
      throw new BadRequestException(
        'One or more ingredients not found in this branch',
      );
    }
    const countNumber = await this.nextNumber(branchId);
    const created = await this.prisma.stockCount.create({
      data: {
        branchId,
        countNumber,
        notes: dto.notes,
        countedById: userId,
        lines: {
          create: dto.lines.map((line) => {
            const ingredient = ingredients.find(
              (item) => item.id === line.ingredientId,
            )!;
            return {
              ingredientId: line.ingredientId,
              expectedQty: ingredient.currentStock,
              countedQty: line.countedQty,
            };
          }),
        },
      },
      include: includeCount,
    });
    return this.withVariance(created);
  }

  async post(branchId: string, userId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const count = await tx.stockCount.findFirst({
        where: { id, branchId },
        include: { lines: true },
      });
      if (!count) throw new NotFoundException('Stock count not found');
      if (count.status === 'POSTED') {
        throw new BadRequestException('This count is already posted');
      }

      for (const line of count.lines) {
        await tx.$queryRaw`SELECT id FROM ingredients WHERE id = ${line.ingredientId} FOR UPDATE`;
        const ingredient = await tx.ingredient.findFirst({
          where: { id: line.ingredientId, branchId },
        });
        if (!ingredient) {
          throw new BadRequestException('Ingredient missing for a count line');
        }
        const counted = Number(line.countedQty);
        const current = Number(ingredient.currentStock);
        const delta = round3(counted - current);
        if (delta === 0) continue;
        if (counted < 0) {
          throw new BadRequestException('Counted quantity cannot be negative');
        }
        await tx.ingredient.update({
          where: { id: ingredient.id },
          data: { currentStock: counted },
        });
        await tx.stockMovement.create({
          data: {
            branchId,
            ingredientId: ingredient.id,
            type: 'ADJUSTMENT',
            quantity: delta,
            note: `Stock count ${count.countNumber}`,
            createdById: userId,
            stockCountId: count.id,
          },
        });
      }

      const posted = await tx.stockCount.update({
        where: { id: count.id },
        data: { status: 'POSTED', postedAt: new Date() },
        include: includeCount,
      });
      return this.withVariance(posted);
    });
  }

  private withVariance<
    T extends {
      lines: {
        expectedQty: unknown;
        countedQty: unknown;
        ingredient: { name: string };
      }[];
    },
  >(count: T) {
    return {
      ...count,
      lines: count.lines.map((line) => {
        const expectedQty = Number(line.expectedQty);
        const countedQty = Number(line.countedQty);
        return {
          ...line,
          expectedQty,
          countedQty,
          varianceQty: round3(countedQty - expectedQty),
        };
      }),
    };
  }

  private async nextNumber(branchId: string) {
    const total = await this.prisma.stockCount.count({ where: { branchId } });
    return `CNT-${String(total + 1).padStart(4, '0')}`;
  }
}
