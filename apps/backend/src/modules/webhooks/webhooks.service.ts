import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { openSecret, sealSecret } from '../../auth/totp';
import { isSqlite, stringList } from '../../common/sqlite';
import { PrismaService } from '../../prisma/prisma.service';
import {
  netOptionsFromEnv,
  resolveWebhookTarget,
  type ResolvedTarget,
} from './net-guard';
import { appReceivesEvents } from './app-target';
import { BACKOFF_MS, MAX_ATTEMPTS, signPayload } from './signing';

export const WEBHOOK_EVENTS = [
  'order.created',
  'order.paid',
  'order.cancelled',
  'reservation.created',
  'delivery.updated',
  'campaign.message',
  'automation.fired',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const TIMEOUT_MS = 8000;
const BATCH = 20;
const CLAIM_MS = 2 * 60_000;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get keyMaterial() {
    return (
      this.config.get<string>('WEBHOOK_KEY') ??
      this.config.getOrThrow<string>('JWT_SECRET')
    );
  }

  // --- Emitting ------------------------------------------------------------

  /**
   * Queues the event for every active endpoint subscribed to it. Never
   * throws: a webhook problem must not fail the order or booking that
   * triggered it.
   */
  async emitForBranch(branchId: string, event: WebhookEvent, data: unknown) {
    try {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { restaurantId: true },
      });
      if (!branch) return;
      await this.emit(branch.restaurantId, event, {
        branchId,
        ...(data as object),
      });
    } catch (err) {
      this.logger.warn(`emit ${event} failed: ${String(err)}`);
    }
  }

  /** Is anything listening for this event? Lets callers fail early and clearly. */
  async hasSubscriber(branchId: string, event: WebhookEvent) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { restaurantId: true },
    });
    if (!branch) return false;
    if (isSqlite()) {
      const rows = await this.prisma.webhookEndpoint.findMany({
        where: { restaurantId: branch.restaurantId, isActive: true },
        select: { events: true },
      });
      return rows.some((row) => stringList(row.events).includes(event));
    }
    const n = await this.prisma.webhookEndpoint.count({
      where: {
        restaurantId: branch.restaurantId,
        isActive: true,
        events: { has: event },
      },
    });
    return n > 0;
  }

  async emit(restaurantId: string, event: WebhookEvent, data: object) {
    const endpoints = isSqlite()
      ? (
          await this.prisma.webhookEndpoint.findMany({
            where: { restaurantId, isActive: true },
            select: { id: true, events: true },
          })
        )
          .filter((row) => stringList(row.events).includes(event))
          .map((row) => ({ id: row.id }))
      : await this.prisma.webhookEndpoint.findMany({
          where: { restaurantId, isActive: true, events: { has: event } },
          select: { id: true },
        });
    const payload = {
      event,
      createdAt: new Date().toISOString(),
      data,
    };
    if (endpoints.length > 0) {
      await this.prisma.webhookDelivery.createMany({
        data: endpoints.map((e) => ({
          endpointId: e.id,
          event,
          payload: payload as Prisma.InputJsonValue,
        })),
      });
    }
    await this.notifyInstalledApps(restaurantId, event, payload);
  }

  /** Same signed event as a webhook. An app with no URL or secret is skipped. */
  private async notifyInstalledApps(
    restaurantId: string,
    event: string,
    payload: object,
  ) {
    const apps = await this.prisma.installedApp.findMany({
      where: { restaurantId, enabled: true },
    });
    for (const app of apps) {
      if (
        !appReceivesEvents({
          enabled: app.enabled,
          baseUrl: app.baseUrl,
          hasSecret: Boolean(app.secretSealed),
        })
      ) {
        continue;
      }
      try {
        await this.postApp(app.baseUrl!, app.secretSealed!, event, payload);
      } catch (err) {
        this.logger.warn(
          `app ${app.name} ${event} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async sendAppTest(restaurantId: string, appId: string) {
    const app = await this.prisma.installedApp.findFirst({
      where: { id: appId, restaurantId },
    });
    if (!app) throw new NotFoundException('App not found');
    if (
      !appReceivesEvents({
        enabled: app.enabled,
        baseUrl: app.baseUrl,
        hasSecret: Boolean(app.secretSealed),
      })
    ) {
      throw new BadRequestException('Turn the app on and store a URL and a secret first');
    }
    const payload = {
      event: 'test',
      createdAt: new Date().toISOString(),
      data: { message: 'Hello from OrderlyPOS' },
    };
    const statusCode = await this.postApp(app.baseUrl!, app.secretSealed!, 'test', payload);
    return { statusCode };
  }

  checkUrl(url: string) {
    return this.assertUrl(url);
  }

  private async postApp(url: string, secretSealed: string, event: string, payload: object) {
    const secret = openSecret(secretSealed, this.keyMaterial);
    const body = JSON.stringify(payload);
    const target = await resolveWebhookTarget(url, netOptionsFromEnv());
    const statusCode = await this.post(target, body, {
      'X-OrderRestro-Event': event,
      'X-OrderRestro-Signature': signPayload(secret, body, Math.floor(Date.now() / 1000)),
    });
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Receiver answered HTTP ${statusCode}`);
    }
    return statusCode;
  }

  // --- Endpoint management -------------------------------------------------

  list(restaurantId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { restaurantId },
      select: {
        id: true,
        url: true,
        events: true,
        description: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(
    restaurantId: string,
    dto: { url: string; events: string[]; description?: string },
  ) {
    const events = this.validateEvents(dto.events);
    await this.assertUrl(dto.url);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const row = await this.prisma.webhookEndpoint.create({
      data: {
        restaurantId,
        url: dto.url,
        events,
        description: dto.description,
        secret: sealSecret(secret, this.keyMaterial),
      },
      select: {
        id: true,
        url: true,
        events: true,
        description: true,
        isActive: true,
      },
    });
    // The signing secret is returned here and never again.
    return { ...row, secret };
  }

  private validateEvents(events: string[]) {
    const unknown = events.filter(
      (e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e),
    );
    if (events.length === 0 || unknown.length > 0)
      throw new BadRequestException(
        unknown.length
          ? `Unknown event: ${unknown.join(', ')}`
          : 'Choose at least one event',
      );
    return [...new Set(events)];
  }

  private async assertUrl(url: string) {
    try {
      await resolveWebhookTarget(url, netOptionsFromEnv());
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Invalid URL',
      );
    }
  }

  private async get(restaurantId: string, id: string) {
    const e = await this.prisma.webhookEndpoint.findFirst({
      where: { id, restaurantId },
    });
    if (!e) throw new NotFoundException('Webhook not found');
    return e;
  }

  async setActive(restaurantId: string, id: string, isActive: boolean) {
    await this.get(restaurantId, id);
    await this.prisma.webhookEndpoint.update({
      where: { id },
      data: { isActive },
    });
    return { ok: true };
  }

  async remove(restaurantId: string, id: string) {
    await this.get(restaurantId, id);
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    return { ok: true };
  }

  async deliveries(restaurantId: string, id: string) {
    await this.get(restaurantId, id);
    return this.prisma.webhookDelivery.findMany({
      where: { endpointId: id },
      select: {
        id: true,
        event: true,
        status: true,
        attempts: true,
        lastStatusCode: true,
        lastError: true,
        createdAt: true,
        deliveredAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** Sends a sample event right now so the receiver can be checked. */
  async sendTest(restaurantId: string, id: string) {
    const e = await this.get(restaurantId, id);
    const row = await this.prisma.webhookDelivery.create({
      data: {
        endpointId: e.id,
        event: 'test',
        payload: {
          event: 'test',
          createdAt: new Date().toISOString(),
          data: { message: 'Hello from OrderlyPOS' },
        },
      },
    });
    await this.attempt(row.id);
    return this.prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: row.id },
      select: {
        status: true,
        attempts: true,
        lastStatusCode: true,
        lastError: true,
      },
    });
  }

  // --- Delivery worker -----------------------------------------------------

  @Cron(CronExpression.EVERY_10_SECONDS)
  async tick() {
    try {
      const due = await this.prisma.webhookDelivery.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
        select: { id: true },
        orderBy: { nextAttemptAt: 'asc' },
        take: BATCH,
      });
      await Promise.all(due.map((d) => this.attempt(d.id)));
    } catch (err) {
      this.logger.error(`webhook tick failed: ${String(err)}`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanup() {
    const cutoff = new Date(Date.now() - 30 * 86_400_000);
    await this.prisma.webhookDelivery.deleteMany({
      where: { status: { not: 'PENDING' }, createdAt: { lt: cutoff } },
    });
  }

  /** One delivery attempt. Claims the row first so overlapping ticks never double-send. */
  async attempt(deliveryId: string) {
    const claimed = await this.prisma.webhookDelivery.updateMany({
      where: {
        id: deliveryId,
        status: 'PENDING',
        nextAttemptAt: { lte: new Date() },
      },
      data: {
        nextAttemptAt: new Date(Date.now() + CLAIM_MS),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) return;

    const d = await this.prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      include: { endpoint: true },
    });
    const body = JSON.stringify(d.payload);
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      if (!d.endpoint.isActive && d.event !== 'test')
        throw new Error('Endpoint is disabled');
      const secret = openSecret(d.endpoint.secret, this.keyMaterial);
      // Re-resolve and re-check on every attempt (the address pinned for
      // this request cannot change between check and connect).
      const target = await resolveWebhookTarget(
        d.endpoint.url,
        netOptionsFromEnv(),
      );
      statusCode = await this.post(target, body, {
        'X-OrderRestro-Event': d.event,
        'X-OrderRestro-Delivery': d.id,
        'X-OrderRestro-Signature': signPayload(
          secret,
          body,
          Math.floor(Date.now() / 1000),
        ),
      });
      if (statusCode < 200 || statusCode >= 300)
        error = `Receiver answered HTTP ${statusCode}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (!error) {
      await this.prisma.webhookDelivery.update({
        where: { id: d.id },
        data: {
          status: 'SUCCESS',
          lastStatusCode: statusCode,
          lastError: null,
          deliveredAt: new Date(),
        },
      });
      return;
    }
    const exhausted = d.attempts >= MAX_ATTEMPTS;
    await this.prisma.webhookDelivery.update({
      where: { id: d.id },
      data: {
        status: exhausted ? 'FAILED' : 'PENDING',
        lastStatusCode: statusCode,
        lastError: error.slice(0, 300),
        nextAttemptAt: new Date(
          Date.now() + (BACKOFF_MS[d.attempts - 1] ?? BACKOFF_MS.at(-1)!),
        ),
      },
    });
  }

  private post(
    target: ResolvedTarget,
    body: string,
    headers: Record<string, string>,
  ): Promise<number> {
    const { url, address, family } = target;
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          timeout: TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'User-Agent': 'OrderRestro-Webhooks/1',
            ...headers,
          },
          // Connect to the address we already vetted; TLS still validates
          // the certificate against the real hostname.
          lookup: (_host, _opts, cb) => cb(null, address, family),
        },
        (res) => {
          res.resume(); // we never read the response body
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('timeout', () =>
        req.destroy(new Error('Timed out after 8 seconds')),
      );
      req.on('error', reject);
      req.end(body);
    });
  }
}
