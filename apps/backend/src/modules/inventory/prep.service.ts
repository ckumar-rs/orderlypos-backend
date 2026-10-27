import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PrepBatchDto, PrepRecipeDto } from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';
import { round3, round4 } from '../../common/money';
import { prepYieldPct, scalePrepInputs } from './inventory-depth';
import { StockService } from './stock.service';

const recipeInclude = {
  outputIngredient: { select: { id: true, name: true, unit: true } },
  lines: {
    include: { ingredient: { select: { id: true, name: true, unit: true } } },
  },
};

const batchInclude = {
  prepRecipe: { select: { id: true, name: true, outputQuantity: true } },
  outputIngredient: { select: { id: true, name: true, unit: true } },
  producedBy: { select: { id: true, name: true } },
  lines: {
    include: { ingredient: { select: { id: true, name: true, unit: true } } },
  },
};

@Injectable()
export class PrepService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  listRecipes(branchId: string) {
    return this.prisma.prepRecipe.findMany({
      where: { branchId },
      include: recipeInclude,
      orderBy: { name: 'asc' },
    });
  }

  async getRecipe(branchId: string, id: string) {
    const recipe = await this.prisma.prepRecipe.findFirst({
      where: { id, branchId },
      include: recipeInclude,
    });
    if (!recipe) throw new NotFoundException('Prep recipe not found');
    return recipe;
  }

  async createRecipe(branchId: string, dto: PrepRecipeDto) {
    await this.assertRecipe(branchId, dto);
    return this.prisma.prepRecipe.create({
      data: {
        branchId,
        name: dto.name.trim(),
        outputIngredientId: dto.outputIngredientId,
        outputQuantity: dto.outputQuantity,
        notes: dto.notes,
        lines: {
          create: dto.lines.map((line) => ({
            ingredientId: line.ingredientId,
            quantity: line.quantity,
          })),
        },
      },
      include: recipeInclude,
    });
  }

  async updateRecipe(branchId: string, id: string, dto: PrepRecipeDto) {
    await this.getRecipe(branchId, id);
    await this.assertRecipe(branchId, dto);
    return this.prisma.$transaction(async (tx) => {
      await tx.prepRecipeLine.deleteMany({ where: { prepRecipeId: id } });
      return tx.prepRecipe.update({
        where: { id },
        data: {
          name: dto.name.trim(),
          outputIngredientId: dto.outputIngredientId,
          outputQuantity: dto.outputQuantity,
          notes: dto.notes,
          lines: {
            create: dto.lines.map((line) => ({
              ingredientId: line.ingredientId,
              quantity: line.quantity,
            })),
          },
        },
        include: recipeInclude,
      });
    });
  }

  async deleteRecipe(branchId: string, id: string) {
    const recipe = await this.prisma.prepRecipe.findFirst({
      where: { id, branchId },
      include: { _count: { select: { batches: true } } },
    });
    if (!recipe) throw new NotFoundException('Prep recipe not found');
    if (recipe._count.batches > 0) {
      throw new BadRequestException(
        'Cannot delete a prep recipe that already has batches',
      );
    }
    await this.prisma.prepRecipe.delete({ where: { id } });
    return { ok: true };
  }

  async listBatches(branchId: string) {
    const batches = await this.prisma.prepBatch.findMany({
      where: { branchId },
      include: {
        prepRecipe: { select: { id: true, name: true, outputQuantity: true } },
        outputIngredient: { select: { id: true, name: true, unit: true } },
        producedBy: { select: { id: true, name: true } },
      },
      orderBy: { producedAt: 'desc' },
    });
    return batches.map((batch) => this.withYield(batch));
  }

  async getBatch(branchId: string, id: string) {
    const batch = await this.prisma.prepBatch.findFirst({
      where: { id, branchId },
      include: batchInclude,
    });
    if (!batch) throw new NotFoundException('Prep batch not found');
    return this.withYield(batch);
  }

  async recordBatch(branchId: string, userId: string, dto: PrepBatchDto) {
    const recipe = await this.prisma.prepRecipe.findFirst({
      where: { id: dto.prepRecipeId, branchId },
      include: { lines: true, outputIngredient: true },
    });
    if (!recipe) throw new NotFoundException('Prep recipe not found');
    const scaled = scalePrepInputs(
      Number(recipe.outputQuantity),
      recipe.lines.map((line) => ({
        ingredientId: line.ingredientId,
        quantity: Number(line.quantity),
      })),
      dto.batchMultiplier,
    );
    const batchNumber = await this.nextBatchNumber(branchId);

    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.prepBatch.create({
        data: {
          branchId,
          prepRecipeId: recipe.id,
          outputIngredientId: recipe.outputIngredientId,
          batchNumber,
          batchMultiplier: dto.batchMultiplier,
          quantityProduced: dto.quantityProduced,
          notes: dto.notes,
          producedById: userId,
        },
      });

      let inputCost = 0;
      for (const line of scaled.inputs) {
        const portions = await this.stock.consumeStock(
          tx,
          branchId,
          line.ingredientId,
          line.quantity,
          {
            type: 'PRODUCTION',
            note: `Prep ${batchNumber}`,
            userId,
            allowNegative: false,
            prepBatchId: batch.id,
          },
        );
        inputCost += portions.reduce(
          (sum, portion) => sum + portion.quantity * portion.unitCost,
          0,
        );
        await tx.prepBatchLine.create({
          data: {
            prepBatchId: batch.id,
            ingredientId: line.ingredientId,
            quantityConsumed: line.quantity,
          },
        });
      }

      const produced = dto.quantityProduced;
      const unitCost = produced > 0 ? round4(inputCost / produced) : 0;
      await tx.$queryRaw`SELECT id FROM ingredients WHERE id = ${recipe.outputIngredientId} FOR UPDATE`;
      const output = await tx.ingredient.findFirst({
        where: { id: recipe.outputIngredientId, branchId },
      });
      if (!output) throw new NotFoundException('Output ingredient not found');

      const stockBatch = await tx.stockBatch.create({
        data: {
          branchId,
          ingredientId: recipe.outputIngredientId,
          batchNumber,
          quantityReceived: produced,
          quantityRemaining: produced,
          unitCost,
        },
      });
      await tx.stockMovement.create({
        data: {
          branchId,
          ingredientId: recipe.outputIngredientId,
          batchId: stockBatch.id,
          type: 'PRODUCTION',
          quantity: produced,
          note: `Prep ${batchNumber}`,
          createdById: userId,
          prepBatchId: batch.id,
        },
      });
      const oldStock = Math.max(0, Number(output.currentStock));
      const oldCost = Number(output.costPerUnit);
      const newStock = round3(oldStock + produced);
      const newCost =
        newStock > 0
          ? round4((oldStock * oldCost + produced * unitCost) / newStock)
          : oldCost;
      await tx.ingredient.update({
        where: { id: output.id },
        data: { currentStock: newStock, costPerUnit: newCost },
      });

      const saved = await tx.prepBatch.findUniqueOrThrow({
        where: { id: batch.id },
        include: batchInclude,
      });
      return this.withYield(saved);
    });
  }

  private withYield<
    T extends {
      batchMultiplier: unknown;
      quantityProduced: unknown;
      prepRecipe: { outputQuantity: unknown };
    },
  >(batch: T) {
    const theoretical = Number(batch.batchMultiplier) * Number(batch.prepRecipe.outputQuantity);
    return {
      ...batch,
      theoreticalOutput: theoretical,
      yieldPct: prepYieldPct(theoretical, Number(batch.quantityProduced)),
    };
  }

  private async assertRecipe(branchId: string, dto: PrepRecipeDto) {
    const ids = [
      dto.outputIngredientId,
      ...dto.lines.map((line) => line.ingredientId),
    ];
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException(
        'Output cannot also be an input, and each input can appear once',
      );
    }
    const ingredients = await this.prisma.ingredient.findMany({
      where: { id: { in: ids }, branchId },
    });
    if (ingredients.length !== ids.length) {
      throw new BadRequestException(
        'One or more ingredients not found in this branch',
      );
    }
  }

  private async nextBatchNumber(branchId: string) {
    const total = await this.prisma.prepBatch.count({ where: { branchId } });
    return `PREP-${String(total + 1).padStart(4, '0')}`;
  }
}
