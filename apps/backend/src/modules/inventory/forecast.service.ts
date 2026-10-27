import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openSecret } from '../../auth/totp';
import { PrismaService } from '../../prisma/prisma.service';
import { round3 } from '../../common/money';
import { completeChatJson, fetchWeatherText } from './ai-chat';
import {
  dailyVelocity,
  parseModelForecast,
  projectHorizon,
  suggestedReorderQty,
} from './forecast-math';
import { planStockUsage, type PlanItem } from './stock-plan';

const includeForecast = {
  generatedBy: { select: { id: true, name: true } },
  lines: { orderBy: [{ kind: 'asc' as const }, { name: 'asc' as const }] },
};

@Injectable()
export class ForecastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  list(branchId: string) {
    return this.prisma.demandForecast.findMany({
      where: { branchId },
      include: {
        generatedBy: { select: { id: true, name: true } },
        _count: { select: { lines: true } },
      },
      orderBy: { generatedAt: 'desc' },
      take: 20,
    });
  }

  async get(branchId: string, id: string) {
    const forecast = await this.prisma.demandForecast.findFirst({
      where: { id, branchId },
      include: includeForecast,
    });
    if (!forecast) throw new NotFoundException('Forecast not found');
    return forecast;
  }

  async generate(branchId: string, userId: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId },
      include: { restaurant: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    const restaurant = branch.restaurant;
    const historyDays = Math.max(1, restaurant.aiHistoryDays || 28);
    const horizonDays = Math.max(1, restaurant.aiHorizonDays || 7);
    const end = new Date();
    const start = new Date(end.getTime() - historyDays * 86_400_000);

    const orders = await this.prisma.order.findMany({
      where: {
        branchId,
        status: 'PAID',
        billedAt: { gte: start, lte: end },
      },
      select: {
        billedAt: true,
        items: {
          select: {
            menuItemId: true,
            quantity: true,
            weightKg: true,
            nameSnapshot: true,
          },
        },
      },
    });

    const soldByItemDay = new Map<string, Map<string, number>>();
    const soldByDay = new Map<string, { menuItemId: string; quantity: number }[]>();
    const itemNames = new Map<string, string>();
    for (const order of orders) {
      const day = (order.billedAt ?? end).toISOString().slice(0, 10);
      for (const item of order.items) {
        const qty = item.weightKg != null ? Number(item.weightKg) : item.quantity;
        if (qty <= 0) continue;
        itemNames.set(item.menuItemId, item.nameSnapshot);
        const days = soldByItemDay.get(item.menuItemId) ?? new Map();
        days.set(day, (days.get(day) ?? 0) + qty);
        soldByItemDay.set(item.menuItemId, days);
        const dayLines = soldByDay.get(day) ?? [];
        dayLines.push({ menuItemId: item.menuItemId, quantity: qty });
        soldByDay.set(day, dayLines);
      }
    }

    const menuItems = await this.prisma.menuItem.findMany({
      where: { branchId },
      include: { recipeLines: true },
    });
    const combos = await this.prisma.comboComponent.findMany({
      where: { comboItem: { branchId } },
    });
    const planItems = new Map<string, PlanItem>(
      menuItems.map((item) => [
        item.id,
        {
          id: item.id,
          name: item.name,
          isCombo: item.isCombo,
          tracking: item.inventoryTracking,
          stockIngredientId: item.stockIngredientId,
          stockQuantityPerSale: Number(item.stockQuantityPerSale),
          recipe: item.recipeLines.map((line) => ({
            ingredientId: line.ingredientId,
            quantity: Number(line.quantity),
          })),
        },
      ]),
    );
    const usedByIngredientDay = new Map<string, Map<string, number>>();
    for (const [day, lines] of soldByDay) {
      const usage = planStockUsage(lines, planItems, combos);
      for (const [ingredientId, qty] of usage.needs) {
        const days = usedByIngredientDay.get(ingredientId) ?? new Map();
        days.set(day, (days.get(day) ?? 0) + qty);
        usedByIngredientDay.set(ingredientId, days);
      }
    }
    const ingredients = await this.prisma.ingredient.findMany({
      where: { branchId, isActive: true },
    });
    const leadByIngredient = await this.leadTimes(branchId, restaurant.aiLeadTimeDays);

    const itemLines = [...soldByItemDay.entries()].map(([menuItemId, days]) => {
      const daily = [...days.entries()].map(([date, qty]) => ({ date, qty }));
      const historyQty = round3(daily.reduce((sum, row) => sum + row.qty, 0));
      const velocity = dailyVelocity(daily);
      const localForecastQty = projectHorizon(daily, horizonDays, end);
      return {
        kind: 'ITEM' as const,
        menuItemId,
        ingredientId: null as string | null,
        name: itemNames.get(menuItemId) ?? planItems.get(menuItemId)?.name ?? menuItemId,
        unit: null as string | null,
        historyQty,
        dailyVelocity: velocity,
        localForecastQty,
        modelForecastQty: null as number | null,
        forecastQty: localForecastQty,
        leadTimeDays: null as number | null,
        currentStock: null as number | null,
        suggestedReorderQty: null as number | null,
      };
    });

    const ingredientLines = ingredients
      .map((ingredient) => {
        const dayMap = usedByIngredientDay.get(ingredient.id) ?? new Map();
        const daily = [...dayMap.entries()].map(([date, qty]) => ({ date, qty }));
        const historyQty = round3(daily.reduce((sum, row) => sum + row.qty, 0));
        const velocity = dailyVelocity(daily);
        const localForecastQty = projectHorizon(daily, horizonDays, end);
        const lead = leadByIngredient.get(ingredient.id) ?? null;
        const current = Number(ingredient.currentStock);
        return {
          kind: 'INGREDIENT' as const,
          menuItemId: null as string | null,
          ingredientId: ingredient.id,
          name: ingredient.name,
          unit: ingredient.unit,
          historyQty,
          dailyVelocity: velocity,
          localForecastQty,
          modelForecastQty: null as number | null,
          forecastQty: localForecastQty,
          leadTimeDays: lead,
          currentStock: current,
          suggestedReorderQty: suggestedReorderQty(
            current,
            velocity,
            lead ?? 0,
            horizonDays,
          ),
        };
      })
      .filter(
        (row) =>
          row.historyQty > 0 ||
          row.suggestedReorderQty > 0 ||
          Number(row.currentStock) > 0,
      );

    let source = 'LOCAL';
    let model: string | null = null;
    let modelError: string | null = null;
    let weatherUsed = false;
    let weatherText = '';

    if (restaurant.weatherBaseUrl) {
      try {
        weatherText = await fetchWeatherText(
          restaurant.weatherBaseUrl,
          restaurant.weatherApiKeySealed
            ? openSecret(restaurant.weatherApiKeySealed, this.keyMaterial())
            : null,
        );
        weatherUsed = true;
      } catch (error) {
        modelError = `Weather: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const token = restaurant.aiTokenSealed
      ? openSecret(restaurant.aiTokenSealed, this.keyMaterial())
      : '';
    if (restaurant.aiEnabled) {
      if (!restaurant.aiBaseUrl || !restaurant.aiModel || !token) {
        throw new BadRequestException(
          'Store the Hugging Face or NVIDIA URL, model id, and token in Settings',
        );
      }
      model = restaurant.aiModel;
      source = restaurant.aiProvider === 'NVIDIA' ? 'NVIDIA' : 'HUGGINGFACE';
      try {
        const reply = await completeChatJson({
          baseUrl: restaurant.aiBaseUrl,
          token,
          model: restaurant.aiModel,
          system:
            'You forecast restaurant sales and ingredient demand. Reply with JSON only: {"items":[{"id":"...","qty":0}],"ingredients":[{"id":"...","qty":0,"reorderQty":0}]}. qty is units over the horizon. Use the history and weekday pattern. Do not invent ids.',
          user: JSON.stringify({
            horizonDays,
            historyDays,
            weather: weatherText || null,
            items: itemLines.map((row) => ({
              id: row.menuItemId,
              name: row.name,
              historyQty: row.historyQty,
              dailyVelocity: row.dailyVelocity,
              localForecastQty: row.localForecastQty,
            })),
            ingredients: ingredientLines.map((row) => ({
              id: row.ingredientId,
              name: row.name,
              unit: row.unit,
              historyQty: row.historyQty,
              dailyVelocity: row.dailyVelocity,
              localForecastQty: row.localForecastQty,
              currentStock: row.currentStock,
              leadTimeDays: row.leadTimeDays,
              localReorderQty: row.suggestedReorderQty,
            })),
          }),
        });
        const parsed = parseModelForecast(reply);
        const itemQty = new Map(parsed.items.map((row) => [row.id, row.qty]));
        const ing = new Map(parsed.ingredients.map((row) => [row.id, row]));
        for (const row of itemLines) {
          const qty = itemQty.get(row.menuItemId ?? '');
          if (qty != null && Number.isFinite(qty) && qty >= 0) {
            row.modelForecastQty = round3(qty);
            row.forecastQty = row.modelForecastQty;
          }
        }
        for (const row of ingredientLines) {
          const hit = ing.get(row.ingredientId ?? '');
          if (!hit) continue;
          if (Number.isFinite(hit.qty) && hit.qty >= 0) {
            row.modelForecastQty = round3(hit.qty);
            row.forecastQty = row.modelForecastQty;
            row.dailyVelocity = horizonDays > 0 ? round3(row.forecastQty / horizonDays) : row.dailyVelocity;
          }
          if (hit.reorderQty != null && Number.isFinite(hit.reorderQty) && hit.reorderQty >= 0) {
            row.suggestedReorderQty = round3(hit.reorderQty);
          } else {
            row.suggestedReorderQty = suggestedReorderQty(
              row.currentStock ?? 0,
              row.dailyVelocity,
              row.leadTimeDays ?? 0,
              horizonDays,
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        modelError = modelError ? `${modelError}; ${message}` : message;
        source = 'LOCAL';
      }
    }

    const count = await this.prisma.demandForecast.count({ where: { branchId } });
    return this.prisma.demandForecast.create({
      data: {
        branchId,
        forecastNumber: `FRC-${String(count + 1).padStart(4, '0')}`,
        historyDays,
        horizonDays,
        source,
        model,
        weatherUsed,
        modelError,
        generatedById: userId,
        lines: {
          create: [...itemLines, ...ingredientLines],
        },
      },
      include: includeForecast,
    });
  }

  async applyReorders(branchId: string, userId: string, forecastId: string) {
    const forecast = await this.get(branchId, forecastId);
    const rows = forecast.lines.filter(
      (line) =>
        line.kind === 'INGREDIENT' &&
        line.ingredientId &&
        Number(line.suggestedReorderQty) > 0,
    );
    if (rows.length === 0) {
      throw new BadRequestException('This forecast has no suggested reorders');
    }
    const count = await this.prisma.purchaseRequest.count({ where: { branchId } });
    return this.prisma.purchaseRequest.create({
      data: {
        branchId,
        requestNumber: `PR-${String(count + 1).padStart(4, '0')}`,
        notes: `Forecast ${forecast.forecastNumber}`,
        requestedById: userId,
        items: {
          create: rows.map((line) => ({
            ingredientId: line.ingredientId!,
            quantityRequested: Number(line.suggestedReorderQty),
            notes: `Velocity ${line.dailyVelocity}/day`,
          })),
        },
      },
      include: { items: { include: { ingredient: true } } },
    });
  }

  private async leadTimes(branchId: string, fallbackDays: number | null) {
    const map = new Map<string, number>();
    const items = await this.prisma.purchaseOrderItem.findMany({
      where: { purchaseOrder: { branchId, status: { not: 'CANCELLED' } } },
      select: {
        ingredientId: true,
        purchaseOrder: {
          select: {
            createdAt: true,
            goodsReceipts: {
              select: { receivedAt: true },
              orderBy: { receivedAt: 'asc' },
              take: 1,
            },
          },
        },
      },
    });
    const sums = new Map<string, { sum: number; n: number }>();
    for (const item of items) {
      const received = item.purchaseOrder.goodsReceipts[0]?.receivedAt;
      if (!received) continue;
      const days =
        (received.getTime() - item.purchaseOrder.createdAt.getTime()) /
        86_400_000;
      if (days < 0) continue;
      const cur = sums.get(item.ingredientId) ?? { sum: 0, n: 0 };
      cur.sum += days;
      cur.n += 1;
      sums.set(item.ingredientId, cur);
    }
    for (const [id, value] of sums) {
      map.set(id, round3(value.sum / value.n));
    }
    const ingredients = await this.prisma.ingredient.findMany({
      where: { branchId, leadTimeDays: { not: null } },
      select: { id: true, leadTimeDays: true },
    });
    for (const ingredient of ingredients) {
      if (!map.has(ingredient.id) && ingredient.leadTimeDays != null) {
        map.set(ingredient.id, Number(ingredient.leadTimeDays));
      }
    }
    if (fallbackDays != null && fallbackDays > 0) {
      const all = await this.prisma.ingredient.findMany({
        where: { branchId },
        select: { id: true },
      });
      for (const ingredient of all) {
        if (!map.has(ingredient.id)) map.set(ingredient.id, fallbackDays);
      }
    }
    return map;
  }

  private keyMaterial() {
    return (
      this.config.get<string>('WEBHOOK_KEY') ??
      this.config.get<string>('JWT_SECRET') ??
      ''
    );
  }
}
