import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { openSecret, sealSecret } from '../../auth/totp';
import { PrismaService } from '../../prisma/prisma.service';
import {
  catalogBatchRequest,
  catalogLifecycle,
  connectionForPhone,
  itemsBatchBody,
  itemsBatchUrl,
  nextCatalogAttempt,
  retailerIdForMenuItem,
  verifyMetaSignature,
  verifyTokenHash,
  wabaCatalogUrl,
  CATALOG_GRAPH_VERSION,
} from './catalog';

export interface CatalogHttpResponse {
  ok: boolean;
  status: number;
  text: string;
}

export type CatalogHttp = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<CatalogHttpResponse>;

const defaultHttp: CatalogHttp = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(15_000),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
};

@Injectable()
export class WhatsAppCatalogService {
  private readonly logger = new Logger(WhatsAppCatalogService.name);
  http: CatalogHttp = defaultHttp;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async pushDue() {
    try {
      await this.processDue(new Date(), 20);
    } catch (err) {
      this.logger.warn(`Catalog sync skipped: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  async get(branchId: string) {
    const row = await this.prisma.whatsAppCatalogConnection.findUnique({ where: { branchId } });
    const products = row ? await this.productViews(row.id) : [];
    const submissions = await this.submissionViews(branchId);
    return {
      ...(row ? this.view(row) : this.emptyView()),
      products,
      submissions,
    };
  }

  async connect(
    restaurantId: string,
    branchId: string,
    input: {
      phoneNumberId: string;
      wabaId: string;
      catalogId: string;
      businessPhone?: string | null;
      kapsoCustomerId?: string | null;
      accessToken?: string | null;
    },
  ) {
    const existing = await this.prisma.whatsAppCatalogConnection.findUnique({ where: { branchId } });
    const token = input.accessToken?.trim() ?? '';
    if (!token && !existing?.accessTokenSealed) {
      throw new BadRequestException('Paste the access token');
    }
    const verifyToken = randomBytes(24).toString('hex');
    const data = {
      restaurantId,
      phoneNumberId: input.phoneNumberId.trim(),
      wabaId: input.wabaId.trim(),
      catalogId: input.catalogId.trim(),
      businessPhone: input.businessPhone?.trim() || null,
      kapsoCustomerId: input.kapsoCustomerId?.trim() || null,
      provider: 'META',
      connectionStatus: 'CONNECTED',
      verifyTokenHash: verifyTokenHash(verifyToken),
      ...(token ? { accessTokenSealed: sealSecret(token, this.keyMaterial()) } : {}),
    };
    try {
      const row = existing
        ? await this.prisma.whatsAppCatalogConnection.update({ where: { id: existing.id }, data })
        : await this.prisma.whatsAppCatalogConnection.create({ data: { ...data, branchId } });
      const link = await this.linkCatalog(row);
      return {
        ...this.view(row),
        verifyToken,
        products: await this.productViews(row.id),
        submissions: await this.submissionViews(branchId),
        catalogLinked: link.ok,
        catalogLinkError: link.error,
      };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That phone number id is already connected');
      }
      throw err;
    }
  }

  async disconnect(branchId: string) {
    const existing = await this.prisma.whatsAppCatalogConnection.findUnique({ where: { branchId } });
    if (!existing) return this.get(branchId);
    await this.prisma.whatsAppCatalogConnection.update({
      where: { id: existing.id },
      data: { connectionStatus: 'DISCONNECTED', accessTokenSealed: null },
    });
    return this.get(branchId);
  }

  async resolve(phoneNumberId: string) {
    const row = await this.prisma.whatsAppCatalogConnection.findUnique({
      where: { phoneNumberId: phoneNumberId.trim() },
      select: {
        phoneNumberId: true,
        connectionStatus: true,
        restaurantId: true,
        branchId: true,
      },
    });
    if (!row) return null;
    const match = connectionForPhone([row], phoneNumberId);
    if (!match) return null;
    return { restaurantId: match.restaurantId, branchId: match.branchId };
  }

  async hubChallenge(query: Record<string, unknown>): Promise<string | null> {
    const mode = String(query['hub.mode'] ?? '');
    const token = String(query['hub.verify_token'] ?? '');
    const challenge = String(query['hub.challenge'] ?? '');
    if (mode !== 'subscribe' || !token || !challenge) return null;
    const row = await this.prisma.whatsAppCatalogConnection.findFirst({
      where: { verifyTokenHash: verifyTokenHash(token), connectionStatus: 'CONNECTED' },
      select: { id: true },
    });
    return row ? challenge : null;
  }

  async applyWebhook(raw: Buffer, header: string | undefined, body: unknown) {
    const secret = this.config.get<string>('META_APP_SECRET') ?? '';
    if (!verifyMetaSignature(raw, header, secret)) {
      throw new UnauthorizedException('WhatsApp signature did not match');
    }
    const parsed = catalogLifecycle(body);
    if (!parsed.phoneNumberId) return { ok: true as const };
    const row = await this.prisma.whatsAppCatalogConnection.findUnique({
      where: { phoneNumberId: parsed.phoneNumberId },
    });
    if (!row) return { ok: true as const };
    await this.prisma.whatsAppCatalogConnection.update({
      where: { id: row.id },
      data: {
        lastWebhookAt: new Date(),
        ...(parsed.status ? { connectionStatus: parsed.status } : {}),
        ...(parsed.status === 'DISCONNECTED' ? { accessTokenSealed: null } : {}),
      },
    });
    return { ok: true as const };
  }

  async retireItem(menuItemId: string) {
    try {
      const row = await this.prisma.whatsAppCatalogProduct.findUnique({
        where: { menuItemId },
        include: {
          connection: true,
          menuItem: {
            select: { id: true, name: true, description: true, price: true, imageUrl: true },
          },
        },
      });
      if (
        !row?.lastSyncedAt ||
        row.connection.connectionStatus !== 'CONNECTED' ||
        !row.connection.accessTokenSealed
      ) {
        return;
      }
      const restaurant = await this.prisma.restaurant.findUnique({
        where: { id: row.connection.restaurantId },
        select: { currency: true },
      });
      const plan = catalogBatchRequest(
        {
          menuItemId: row.menuItem.id,
          name: row.menuItem.name,
          description: row.menuItem.description,
          price: Number(row.menuItem.price),
          currency: restaurant?.currency ?? 'INR',
          imageUrl: row.menuItem.imageUrl,
          isActive: false,
          link: null,
        },
        null,
      );
      if (!plan.ok) return;
      const token = openSecret(row.connection.accessTokenSealed, this.keyMaterial());
      const url = itemsBatchUrl(
        this.config.get<string>('META_GRAPH_BASE') ?? 'https://graph.facebook.com',
        this.config.get<string>('META_GRAPH_API_VERSION') ?? CATALOG_GRAPH_VERSION,
        row.connection.catalogId,
      );
      await this.http(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(itemsBatchBody([plan.request])),
      });
    } catch (err) {
      this.logger.warn(`Catalog retire skipped: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  async markDirty(menuItemId: string) {
    try {
      const item = await this.prisma.menuItem.findUnique({
        where: { id: menuItemId },
        select: { id: true, branchId: true },
      });
      if (!item) return;
      const connection = await this.prisma.whatsAppCatalogConnection.findUnique({
        where: { branchId: item.branchId },
      });
      if (!connection || connection.connectionStatus !== 'CONNECTED') return;
      await this.prisma.whatsAppCatalogProduct.upsert({
        where: { menuItemId: item.id },
        create: {
          connectionId: connection.id,
          menuItemId: item.id,
          retailerId: retailerIdForMenuItem(item.id),
          syncStatus: 'PENDING',
          nextAttemptAt: new Date(),
        },
        update: { syncStatus: 'PENDING', nextAttemptAt: new Date(), lastError: null },
      });
    } catch (err) {
      this.logger.warn(`Catalog mark skipped: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  async syncBranch(branchId: string) {
    const connection = await this.requireConnected(branchId);
    const items = await this.prisma.menuItem.findMany({
      where: { branchId },
      select: { id: true },
    });
    for (const item of items) {
      await this.prisma.whatsAppCatalogProduct.upsert({
        where: { menuItemId: item.id },
        create: {
          connectionId: connection.id,
          menuItemId: item.id,
          retailerId: retailerIdForMenuItem(item.id),
          syncStatus: 'PENDING',
          nextAttemptAt: new Date(),
        },
        update: { syncStatus: 'PENDING', nextAttemptAt: new Date() },
      });
    }
    const result = await this.processDue(new Date(), Math.max(items.length, 1), branchId);
    return { ...result, ...(await this.get(branchId)) };
  }

  async retryItem(branchId: string, menuItemId: string) {
    const connection = await this.requireConnected(branchId);
    const row = await this.prisma.whatsAppCatalogProduct.findFirst({
      where: { connectionId: connection.id, menuItemId },
    });
    if (!row) throw new NotFoundException('That item is not on the catalog list');
    await this.prisma.whatsAppCatalogProduct.update({
      where: { id: row.id },
      data: { syncStatus: 'PENDING', nextAttemptAt: new Date(), lastError: null },
    });
    await this.processDue(new Date(), 1, branchId);
    return this.get(branchId);
  }

  async processDue(now: Date, limit: number, branchId?: string) {
    const due = await this.prisma.whatsAppCatalogProduct.findMany({
      where: {
        syncStatus: { in: ['PENDING', 'FAILED'] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        connection: {
          connectionStatus: 'CONNECTED',
          ...(branchId ? { branchId } : {}),
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      include: {
        connection: true,
        menuItem: {
          select: {
            id: true,
            name: true,
            description: true,
            price: true,
            imageUrl: true,
            isActive: true,
          },
        },
      },
    });
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const row of due) {
      const outcome = await this.pushOne(row, now);
      if (outcome === 'sent') sent += 1;
      else if (outcome === 'failed') failed += 1;
      else skipped += 1;
    }
    return { sent, failed, skipped, checked: due.length };
  }

  private async pushOne(
    row: {
      id: string;
      attempts: number;
      payloadHash: string | null;
      lastSyncedAt: Date | null;
      connection: {
        catalogId: string;
        accessTokenSealed: string | null;
        restaurantId: string;
      };
      menuItem: {
        id: string;
        name: string;
        description: string | null;
        price: Prisma.Decimal;
        imageUrl: string | null;
        isActive: boolean;
      };
    },
    now: Date,
  ): Promise<'sent' | 'failed' | 'skipped'> {
    if (!row.menuItem.isActive && !row.lastSyncedAt) {
      await this.prisma.whatsAppCatalogProduct.update({
        where: { id: row.id },
        data: { syncStatus: 'OUT_OF_STOCK', lastError: null, nextAttemptAt: null },
      });
      return 'skipped';
    }
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: row.connection.restaurantId },
      select: { currency: true },
    });
    const plan = catalogBatchRequest(
      {
        menuItemId: row.menuItem.id,
        name: row.menuItem.name,
        description: row.menuItem.description,
        price: Number(row.menuItem.price),
        currency: restaurant?.currency ?? 'INR',
        imageUrl: row.menuItem.imageUrl,
        isActive: row.menuItem.isActive,
        link: this.httpsLink(),
      },
      this.config.get<string>('PUBLIC_ASSET_BASE_URL') ?? null,
    );
    if (!plan.ok) {
      await this.fail(row.id, row.attempts, plan.reason, now);
      return 'failed';
    }
    if (row.payloadHash === plan.hash && row.lastSyncedAt) {
      await this.prisma.whatsAppCatalogProduct.update({
        where: { id: row.id },
        data: {
          syncStatus: plan.availability === 'in stock' ? 'SYNCED' : 'OUT_OF_STOCK',
          lastError: null,
          attempts: 0,
          nextAttemptAt: null,
        },
      });
      return 'skipped';
    }
    if (!row.connection.accessTokenSealed) {
      await this.fail(row.id, row.attempts, 'Paste the access token', now);
      return 'failed';
    }
    let token = '';
    try {
      token = openSecret(row.connection.accessTokenSealed, this.keyMaterial());
    } catch {
      await this.fail(row.id, row.attempts, 'The saved access token could not be opened', now);
      return 'failed';
    }
    const url = itemsBatchUrl(
      this.config.get<string>('META_GRAPH_BASE') ?? 'https://graph.facebook.com',
      this.config.get<string>('META_GRAPH_API_VERSION') ?? CATALOG_GRAPH_VERSION,
      row.connection.catalogId,
    );
    try {
      const response = await this.http(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(itemsBatchBody([plan.request])),
      });
      if (!response.ok) {
        await this.fail(row.id, row.attempts, `Meta returned ${response.status}`, now);
        return 'failed';
      }
    } catch {
      await this.fail(row.id, row.attempts, 'Meta could not be reached', now);
      return 'failed';
    }
    await this.prisma.whatsAppCatalogProduct.update({
      where: { id: row.id },
      data: {
        payloadHash: plan.hash,
        syncStatus: plan.availability === 'in stock' ? 'SYNCED' : 'OUT_OF_STOCK',
        attempts: 0,
        lastError: null,
        lastSyncedAt: now,
        nextAttemptAt: null,
      },
    });
    return 'sent';
  }

  private async fail(id: string, attempts: number, reason: string, now: Date) {
    const next = attempts + 1;
    await this.prisma.whatsAppCatalogProduct.update({
      where: { id },
      data: {
        syncStatus: 'FAILED',
        attempts: next,
        lastError: reason.slice(0, 300),
        nextAttemptAt: nextCatalogAttempt(next, now),
      },
    });
  }

  private async requireConnected(branchId: string) {
    const connection = await this.prisma.whatsAppCatalogConnection.findUnique({ where: { branchId } });
    if (!connection || connection.connectionStatus !== 'CONNECTED') {
      throw new BadRequestException('Connect WhatsApp catalog before syncing');
    }
    if (!connection.catalogId.trim()) {
      throw new BadRequestException('Set the Meta catalog id');
    }
    return connection;
  }

  private async linkCatalog(row: {
    wabaId: string;
    catalogId: string;
    accessTokenSealed: string | null;
  }): Promise<{ ok: boolean; error: string | null }> {
    if (!row.accessTokenSealed) return { ok: false, error: 'Paste the access token' };
    try {
      const token = openSecret(row.accessTokenSealed, this.keyMaterial());
      const url = wabaCatalogUrl(
        this.config.get<string>('META_GRAPH_BASE') ?? 'https://graph.facebook.com',
        this.config.get<string>('META_GRAPH_API_VERSION') ?? CATALOG_GRAPH_VERSION,
        row.wabaId,
      );
      const response = await this.http(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ catalog_id: row.catalogId }),
      });
      if (!response.ok) return { ok: false, error: `Meta returned ${response.status}` };
      return { ok: true, error: null };
    } catch {
      return { ok: false, error: 'Meta could not be reached' };
    }
  }

  private async submissionViews(branchId: string) {
    const rows = await this.prisma.whatsAppCatalogSubmission.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const orderIds = rows.map((row) => row.orderId).filter((id): id is string => Boolean(id));
    const orders =
      orderIds.length === 0
        ? ([] as Array<{ id: string; orderNumber: string; status: string }>)
        : await this.prisma.order.findMany({
            where: { id: { in: orderIds } },
            select: { id: true, orderNumber: true, status: true },
          });
    const byId = new Map(orders.map((order) => [order.id, order] as const));
    return rows.map((row) => ({
      messageId: row.messageId,
      submissionStatus: row.submissionStatus,
      rejectionReason: row.rejectionReason,
      orderNumber: row.orderId ? byId.get(row.orderId)?.orderNumber ?? null : null,
      orderStatus: row.orderId ? byId.get(row.orderId)?.status ?? null : null,
      createdAt: row.createdAt,
    }));
  }

  private async productViews(connectionId: string) {
    const rows = await this.prisma.whatsAppCatalogProduct.findMany({
      where: { connectionId },
      include: { menuItem: { select: { name: true, price: true, isActive: true } } },
      orderBy: { menuItem: { name: 'asc' } },
    });
    return rows.map((row) => ({
      menuItemId: row.menuItemId,
      name: row.menuItem.name,
      price: Number(row.menuItem.price),
      isActive: row.menuItem.isActive,
      retailerId: row.retailerId,
      syncStatus: row.syncStatus,
      attempts: row.attempts,
      lastError: row.lastError,
      lastSyncedAt: row.lastSyncedAt,
    }));
  }

  private view(row: {
    connectionStatus: string;
    phoneNumberId: string;
    wabaId: string;
    catalogId: string;
    businessPhone: string | null;
    kapsoCustomerId: string | null;
    provider: string;
    accessTokenSealed: string | null;
    lastWebhookAt: Date | null;
  }) {
    return {
      connected: row.connectionStatus === 'CONNECTED',
      connectionStatus: row.connectionStatus,
      phoneNumberId: row.phoneNumberId,
      wabaId: row.wabaId,
      catalogId: row.catalogId,
      businessPhone: row.businessPhone,
      kapsoCustomerId: row.kapsoCustomerId,
      provider: row.provider,
      accessTokenConfigured: Boolean(row.accessTokenSealed),
      webhookPath: '/api/v1/public/whatsapp/catalog',
      lastWebhookAt: row.lastWebhookAt,
    };
  }

  private emptyView() {
    return {
      connected: false,
      connectionStatus: 'DISCONNECTED',
      phoneNumberId: '',
      wabaId: '',
      catalogId: '',
      businessPhone: null as string | null,
      kapsoCustomerId: null as string | null,
      provider: 'META',
      accessTokenConfigured: false,
      webhookPath: '/api/v1/public/whatsapp/catalog',
      lastWebhookAt: null as Date | null,
    };
  }

  private httpsLink(): string | null {
    const base = this.config.get<string>('PUBLIC_MENU_BASE_URL')?.trim() ?? '';
    return /^https:\/\//i.test(base) ? base.replace(/\/$/, '') : null;
  }

  private keyMaterial() {
    const key = this.config.get<string>('WEBHOOK_KEY') ?? this.config.get<string>('JWT_SECRET') ?? '';
    if (key.length < 16) {
      throw new BadRequestException('Set WEBHOOK_KEY or JWT_SECRET before saving a WhatsApp token');
    }
    return key;
  }
}
