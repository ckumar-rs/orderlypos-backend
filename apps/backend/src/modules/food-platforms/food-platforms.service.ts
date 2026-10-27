import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { CreateOrderDto } from '@nodedr-restaurant/types';
import { openSecret, sealSecret } from '../../auth/totp';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import {
  IntakePayloadError,
  normalizeIntake,
} from './normalize-intake';

export const FOOD_PLATFORMS = ['ZOMATO', 'SWIGGY'] as const;
export type FoodPlatformName = (typeof FOOD_PLATFORMS)[number];

const LABELS: Record<FoodPlatformName, string> = {
  ZOMATO: 'Zomato',
  SWIGGY: 'Swiggy',
};

export function parseFoodPlatform(raw: string): FoodPlatformName {
  const value = raw.trim().toUpperCase();
  if (value === 'ZOMATO' || value === 'SWIGGY') return value;
  throw new BadRequestException('Platform must be zomato or swiggy');
}

export function foodPlatformWebhookPath(platform: FoodPlatformName): string {
  return `/api/v1/public/food-platforms/${platform.toLowerCase()}/orders`;
}

export interface FoodPlatformConnectionView {
  platform: FoodPlatformName;
  label: string;
  enabled: boolean;
  outletId: string | null;
  secret: string | null;
  webhookPath: string;
  apiBaseUrl: string | null;
  apiKeyConfigured: boolean;
  storeOpen: boolean;
  riderWebhookPath: string;
}

export interface IntakeResult {
  orderId: string;
  orderNumber: string;
  duplicate: boolean;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function isPlatformIdConflict(err: unknown): boolean {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== 'P2002'
  ) {
    return false;
  }
  const target = err.meta?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.includes('externalOrderId') || text.includes('foodPlatform');
}

function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

@Injectable()
export class FoodPlatformsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly orders: OrdersService,
  ) {}

  private get keyMaterial() {
    return (
      this.config.get<string>('WEBHOOK_KEY') ??
      this.config.getOrThrow<string>('JWT_SECRET')
    );
  }

  async list(branchId: string): Promise<FoodPlatformConnectionView[]> {
    const rows = await this.prisma.foodPlatformIntake.findMany({
      where: { branchId },
    });
    return FOOD_PLATFORMS.map((platform) =>
      this.toView(platform, rows.find((row) => row.platform === platform)),
    );
  }

  async enable(branchId: string, platform: FoodPlatformName, outletId?: string | null) {
    const existing = await this.prisma.foodPlatformIntake.findUnique({
      where: { branchId_platform: { branchId, platform } },
    });
    const outlet = this.cleanOutlet(outletId, existing?.outletId ?? null);
    if (existing) {
      const row = await this.prisma.foodPlatformIntake.update({
        where: { id: existing.id },
        data: { enabled: true, outletId: outlet },
      });
      return this.toView(platform, row);
    }
    const secret = randomBytes(24).toString('base64url');
    const row = await this.prisma.foodPlatformIntake.create({
      data: {
        branchId,
        platform,
        enabled: true,
        outletId: outlet,
        secretHash: hashSecret(secret),
        secretSealed: sealSecret(secret, this.keyMaterial),
      },
    });
    return this.toView(platform, row);
  }

  async rotate(branchId: string, platform: FoodPlatformName) {
    const existing = await this.prisma.foodPlatformIntake.findUnique({
      where: { branchId_platform: { branchId, platform } },
    });
    if (!existing) {
      throw new BadRequestException('Turn intake on before replacing the secret');
    }
    const secret = randomBytes(24).toString('base64url');
    const row = await this.prisma.foodPlatformIntake.update({
      where: { id: existing.id },
      data: {
        secretHash: hashSecret(secret),
        secretSealed: sealSecret(secret, this.keyMaterial),
      },
    });
    return this.toView(platform, row);
  }

  async disable(branchId: string, platform: FoodPlatformName) {
    const existing = await this.prisma.foodPlatformIntake.findUnique({
      where: { branchId_platform: { branchId, platform } },
    });
    if (!existing) return this.toView(platform, undefined);
    const row = await this.prisma.foodPlatformIntake.update({
      where: { id: existing.id },
      data: { enabled: false },
    });
    return this.toView(platform, row);
  }

  async setOutlet(branchId: string, platform: FoodPlatformName, outletId: string | null) {
    const existing = await this.prisma.foodPlatformIntake.findUnique({
      where: { branchId_platform: { branchId, platform } },
    });
    if (!existing) {
      throw new BadRequestException('Turn intake on before saving an outlet id');
    }
    const row = await this.prisma.foodPlatformIntake.update({
      where: { id: existing.id },
      data: { outletId: this.cleanOutlet(outletId, null) },
    });
    return this.toView(platform, row);
  }

  /**
   * Turns one platform order into a delivery ticket. The secret selects the
   * branch. A repeated external order id returns the original ticket.
   * Unmatched dish names reject the whole order.
   */
  async intake(
    platformRaw: string,
    secret: string | undefined,
    body: unknown,
  ): Promise<IntakeResult> {
    const platform = parseFoodPlatform(platformRaw);
    if (!secret) throw new UnauthorizedException('Missing platform secret');

    const connection = await this.prisma.foodPlatformIntake.findFirst({
      where: { secretHash: hashSecret(secret), platform, enabled: true },
    });
    if (!connection) throw new UnauthorizedException('Invalid platform secret');

    let payload;
    try {
      payload = normalizeIntake(body);
    } catch (err) {
      if (err instanceof IntakePayloadError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    if (
      connection.outletId &&
      payload.outletId &&
      connection.outletId !== payload.outletId
    ) {
      throw new BadRequestException('This outlet is not linked to this branch');
    }

    const existing = await this.findExisting(
      connection.branchId,
      platform,
      payload.externalOrderId,
    );
    if (existing) {
      return {
        orderId: existing.id,
        orderNumber: existing.orderNumber,
        duplicate: true,
      };
    }

    const menu = await this.prisma.menuItem.findMany({
      where: { branchId: connection.branchId, isActive: true },
      select: { id: true, name: true },
    });
    const byId = new Map(menu.map((item) => [item.id, item.id]));
    const byName = new Map<string, string>();
    for (const item of menu) {
      const key = normName(item.name);
      if (!byName.has(key)) byName.set(key, item.id);
    }

    const unmatched: string[] = [];
    const items: CreateOrderDto['items'] = payload.items.map((line) => {
      const menuItemId =
        (line.menuItemId && byId.get(line.menuItemId)) ||
        byName.get(normName(line.name));
      if (!menuItemId) unmatched.push(line.name);
      return {
        menuItemId: menuItemId ?? line.name,
        quantity: line.quantity,
        kitchenNote: line.note,
        modifierIds: [],
      };
    });
    if (unmatched.length > 0) {
      throw new ConflictException({
        message: `These dishes are not on this branch's menu: ${unmatched.join(', ')}`,
        unmatched,
      });
    }

    const staff = await this.prisma.userBranch.findFirst({
      where: { branchId: connection.branchId },
      select: { userId: true },
    });
    if (!staff) {
      throw new BadRequestException('This branch has no staff user to own the order');
    }

    const label = LABELS[platform];
    const notes = [`${label} #${payload.externalOrderId}`, payload.instructions]
      .filter(Boolean)
      .join(' — ')
      .slice(0, 500);

    try {
      const order = await this.orders.createOrder(
        connection.branchId,
        staff.userId,
        {
          type: 'DELIVERY',
          guestName: payload.customerName ?? undefined,
          notes,
          delivery: {
            address: payload.address,
            phone: payload.phone,
            pincode: payload.pincode ?? '',
          },
          items,
        },
        {
          channel: 'STAFF',
          skipDeliveryZone: true,
          foodPlatform: platform,
          externalOrderId: payload.externalOrderId,
        },
      );
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        duplicate: false,
      };
    } catch (err) {
      if (isPlatformIdConflict(err)) {
        const again = await this.findExisting(
          connection.branchId,
          platform,
          payload.externalOrderId,
        );
        if (again) {
          return {
            orderId: again.id,
            orderNumber: again.orderNumber,
            duplicate: true,
          };
        }
      }
      throw err;
    }
  }

  private async findExisting(
    branchId: string,
    platform: FoodPlatformName,
    externalOrderId: string,
  ) {
    return this.prisma.order.findFirst({
      where: { branchId, foodPlatform: platform, externalOrderId },
      select: { id: true, orderNumber: true },
    });
  }

  private cleanOutlet(incoming: string | null | undefined, fallback: string | null) {
    if (incoming === undefined) return fallback;
    const trimmed = incoming?.trim() ?? '';
    return trimmed ? trimmed.slice(0, 80) : null;
  }

  private toView(
    platform: FoodPlatformName,
    row:
      | {
          enabled: boolean;
          outletId: string | null;
          secretSealed: string;
          apiBaseUrl?: string | null;
          apiKeySealed?: string | null;
          storeOpen?: boolean;
        }
      | undefined,
  ): FoodPlatformConnectionView {
    let secret: string | null = null;
    if (row) {
      try {
        secret = openSecret(row.secretSealed, this.keyMaterial);
      } catch {
        secret = null;
      }
    }
    return {
      platform,
      label: LABELS[platform],
      enabled: row?.enabled ?? false,
      outletId: row?.outletId ?? null,
      secret,
      webhookPath: foodPlatformWebhookPath(platform),
      apiBaseUrl: row?.apiBaseUrl ?? null,
      apiKeyConfigured: Boolean(row?.apiKeySealed),
      storeOpen: row?.storeOpen ?? true,
      riderWebhookPath: `/api/v1/public/food-platforms/${platform.toLowerCase()}/rider`,
    };
  }

  async saveApi(
    branchId: string,
    platform: FoodPlatformName,
    dto: { apiBaseUrl?: string | null; apiKey?: string | null; storeOpen?: boolean },
  ) {
    const existing = await this.prisma.foodPlatformIntake.findUnique({
      where: { branchId_platform: { branchId, platform } },
    });
    if (!existing) throw new BadRequestException('Turn the platform on before storing its API');
    const row = await this.prisma.foodPlatformIntake.update({
      where: { id: existing.id },
      data: {
        apiBaseUrl: dto.apiBaseUrl?.trim() || null,
        storeOpen: dto.storeOpen ?? existing.storeOpen,
        ...(dto.apiKey ? { apiKeySealed: sealSecret(dto.apiKey, this.keyMaterial) } : {}),
      },
    });
    return this.toView(platform, row);
  }

  async publishMenu(branchId: string, platform: FoodPlatformName) {
    const items = await this.prisma.menuItem.findMany({
      where: { branchId, isActive: true },
      select: { id: true, name: true, price: true, sku: true, isActive: true },
    });
    return this.pushPlatform(branchId, platform, {
      action: 'menu',
      items: items.map((item) => ({ ...item, price: Number(item.price) })),
    });
  }

  async pushStore(branchId: string, platform: FoodPlatformName, open: boolean) {
    await this.saveApi(branchId, platform, { storeOpen: open });
    return this.pushPlatform(branchId, platform, { action: 'store', open });
  }

  async pushStock(branchId: string, platform: FoodPlatformName, itemIds: string[]) {
    return this.pushPlatform(branchId, platform, { action: 'stock', itemIds });
  }

  async rider(platform: FoodPlatformName, secret: string, body: unknown) {
    const row = await this.prisma.foodPlatformIntake.findFirst({
      where: { secretHash: hashSecret(secret), platform, enabled: true },
    });
    if (!row) throw new UnauthorizedException('Platform secret did not match');
    const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const externalOrderId = String(payload.externalOrderId ?? payload.orderId ?? '');
    if (!externalOrderId) throw new BadRequestException('externalOrderId is required');
    const order = await this.prisma.order.findFirst({
      where: { branchId: row.branchId, foodPlatform: platform, externalOrderId },
    });
    if (!order) throw new BadRequestException('Order not found');
    const status = String(payload.status ?? '').toUpperCase();
    const deliveryStatus = status.includes('DELIVER')
      ? 'DELIVERED'
      : status.includes('PICK')
        ? 'PICKED_UP'
        : status.includes('ASSIGN') || status.includes('RIDER')
          ? 'ASSIGNED'
          : null;
    if (deliveryStatus) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { deliveryStatus: deliveryStatus as never, demoPlatformStatus: status },
      });
    }
    return { ok: true };
  }

  private async pushPlatform(branchId: string, platform: FoodPlatformName, body: unknown) {
    const row = await this.prisma.foodPlatformIntake.findUnique({
      where: { branchId_platform: { branchId, platform } },
    });
    if (!row?.apiBaseUrl || !row.apiKeySealed) {
      throw new BadRequestException('Store the platform API URL and key first');
    }
    const key = openSecret(row.apiKeySealed, this.keyMaterial);
    const response = await fetch(row.apiBaseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new BadRequestException(`Platform returned HTTP ${response.status}`);
    return { ok: true };
  }
}
