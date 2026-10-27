import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { EmailService } from '../email/email.service';
import { MessagingService } from '../messaging/messaging.service';
import { ReportsService } from '../reports/reports.service';
import { netOptionsFromEnv, resolveWebhookTarget } from '../webhooks/net-guard';
import { WebhooksService } from '../webhooks/webhooks.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { clientIp, ipAllowed } from './access';
import { chainLoops, normalizeActions, type AutomationAction } from './automation-plan';
import { isFieldEntity } from './field-entities';

const ONLINE_MS = 2 * 60 * 1000;
const TRIGGERS = ['ORDER_PAID', 'LOW_STOCK', 'RESERVATION_TODAY'] as const;

@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly messaging: MessagingService,
    private readonly webhooks: WebhooksService,
  ) {}

  async scoreboard(restaurantId: string) {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const branches = await this.prisma.branch.findMany({
      where: { restaurantId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const ids = branches.map((branch) => branch.id);
    const [orders, noShows] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['branchId'],
        where: { branchId: { in: ids }, status: 'PAID', billedAt: { gte: start } },
        _sum: { totalAmount: true, guestCount: true },
        _count: { _all: true },
      }),
      this.prisma.reservation.groupBy({
        by: ['branchId'],
        where: { branchId: { in: ids }, status: 'NO_SHOW', reservedAt: { gte: start } },
        _count: { id: true },
      }),
    ]);
    const sales = new Map(orders.map((row) => [row.branchId, row]));
    const missed = new Map(noShows.map((row) => [row.branchId, row._count.id]));
    return branches
      .map((branch) => {
        const row = sales.get(branch.id);
        const count = row?._count._all ?? 0;
        const total = Number(row?._sum.totalAmount ?? 0);
        return {
          branchId: branch.id,
          name: branch.name,
          orders: count,
          sales: total.toFixed(2),
          aov: (count ? total / count : 0).toFixed(2),
          covers: Number(row?._sum.guestCount ?? 0),
          noShows: missed.get(branch.id) ?? 0,
        };
      })
      .sort((a, b) => Number(b.sales) - Number(a.sales));
  }

  async franchise(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { franchisePriceLock: true },
    });
    return { priceLock: restaurant?.franchisePriceLock ?? false, branches: await this.scoreboard(restaurantId) };
  }

  async setPriceLock(restaurantId: string, priceLock: boolean) {
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { franchisePriceLock: priceLock },
    });
    return this.franchise(restaurantId);
  }

  async devices(branchId: string) {
    const rows = await this.prisma.posDevice.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
    });
    const now = Date.now();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      appVersion: row.appVersion,
      lastSeenAt: row.lastSeenAt,
      config: row.config,
      online: !!row.lastSeenAt && now - row.lastSeenAt.getTime() < ONLINE_MS,
    }));
  }

  async registerDevice(branchId: string, name: string) {
    const token = randomBytes(24).toString('base64url');
    const row = await this.prisma.posDevice.create({
      data: {
        branchId,
        name: name.trim().slice(0, 80) || 'Register',
        tokenHash: this.hashToken(token),
      },
    });
    return { id: row.id, token };
  }

  async saveDeviceConfig(branchId: string, id: string, config: Record<string, unknown>) {
    const row = await this.prisma.posDevice.findFirst({ where: { id, branchId } });
    if (!row) throw new NotFoundException('Device not found');
    return this.prisma.posDevice.update({
      where: { id },
      data: { config: config as Prisma.InputJsonValue },
    });
  }

  async heartbeat(token: string | undefined, version?: string) {
    const row = await this.deviceByToken(token);
    return this.prisma.posDevice.update({
      where: { id: row.id },
      data: { lastSeenAt: new Date(), ...(version ? { appVersion: version.slice(0, 40) } : {}) },
      select: { id: true, name: true, config: true, lastSeenAt: true },
    });
  }

  async deviceConfig(token: string | undefined) {
    const row = await this.deviceByToken(token);
    return { id: row.id, name: row.name, config: row.config };
  }

  async security(restaurantId: string, headers: Record<string, string | string[] | undefined>, ip?: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { ipAllowList: true, requireDevice: true },
    });
    return {
      ipAllowList: restaurant?.ipAllowList ?? '',
      requireDevice: restaurant?.requireDevice ?? false,
      requestIp: clientIp(headers, ip ?? ''),
    };
  }

  async saveSecurity(
    restaurantId: string,
    input: { ipAllowList: string; requireDevice: boolean },
  ) {
    const ipAllowList = input.ipAllowList
      .split(',')
      .map((row) => row.trim())
      .filter(Boolean)
      .join(', ');
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { ipAllowList, requireDevice: input.requireDevice },
    });
    return { ipAllowList, requireDevice: input.requireDevice };
  }

  async assertRequest(
    restaurantId: string,
    req: {
      headers: Record<string, string | string[] | undefined>;
      ip?: string;
      method: string;
      originalUrl?: string;
      url?: string;
    },
  ) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { ipAllowList: true, requireDevice: true },
    });
    const ip = clientIp(req.headers, req.ip ?? '');
    if (!ipAllowed(restaurant?.ipAllowList ?? '', ip)) {
      throw new ForbiddenException(`This network (${ip || 'unknown'}) is not on the allow list`);
    }
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const registering = req.method === 'POST' && path.endsWith('/platform/devices');
    if (!restaurant?.requireDevice || registering) return;
    const token = header(req.headers, 'x-device-token');
    if (!token) throw new ForbiddenException('This restaurant requires a registered device');
    const device = await this.prisma.posDevice.findFirst({
      where: { tokenHash: this.hashToken(token), branch: { restaurantId } },
      select: { id: true },
    });
    if (!device) throw new ForbiddenException('This device is not registered');
  }

  async fields(branchId: string, entity: string, entityId?: string) {
    if (!isFieldEntity(entity)) {
      throw new BadRequestException('That record type does not take extra fields');
    }
    const definitions = await this.prisma.customField.findMany({
      where: { branchId, entity },
      orderBy: { label: 'asc' },
      include: { values: { where: { entityId: entityId ?? '' }, take: 1 } },
    });
    return definitions.map((field) => ({
      id: field.id,
      entity: field.entity,
      key: field.key,
      label: field.label,
      value: field.values[0]?.value ?? '',
    }));
  }

  async addField(branchId: string, input: { entity: string; key: string; label: string }) {
    if (!isFieldEntity(input.entity)) {
      throw new BadRequestException('That record type does not take extra fields');
    }
    const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
    if (!key) throw new BadRequestException('Give the field a short key');
    const label = input.label.trim().slice(0, 80);
    if (!label) throw new BadRequestException('Give the field a label');
    try {
      return await this.prisma.customField.create({
        data: { branchId, entity: input.entity, key, label },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException('That key is already used on this record type');
      }
      throw err;
    }
  }

  async fieldEntity(branchId: string, fieldId: string) {
    const field = await this.prisma.customField.findFirst({
      where: { id: fieldId, branchId },
      select: { entity: true },
    });
    if (!field) throw new NotFoundException('Field not found');
    return field.entity;
  }

  async saveFieldValue(branchId: string, fieldId: string, entityId: string, value: string) {
    if (!entityId.trim()) throw new BadRequestException('Choose the record this value belongs to');
    const field = await this.prisma.customField.findFirst({ where: { id: fieldId, branchId } });
    if (!field) throw new NotFoundException('Field not found');
    return this.prisma.customFieldValue.upsert({
      where: { fieldId_entityId: { fieldId, entityId } },
      create: { fieldId, entityId, value: value.slice(0, 500) },
      update: { value: value.slice(0, 500) },
    });
  }

  async savedReports(branchId: string) {
    return this.prisma.savedReport.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addSavedReport(branchId: string, input: { name: string; reportKey: string; days: number }) {
    return this.prisma.savedReport.create({
      data: {
        branchId,
        name: input.name.trim().slice(0, 80),
        reportKey: input.reportKey,
        days: Math.min(366, Math.max(1, input.days)),
      },
    });
  }

  async runSavedReport(branchId: string, id: string) {
    const saved = await this.prisma.savedReport.findFirst({ where: { id, branchId } });
    if (!saved) throw new NotFoundException('Saved report not found');
    const to = new Date();
    const from = new Date(to.getTime() - saved.days * 86_400_000);
    const fmt = (date: Date) => date.toISOString().slice(0, 10);
    const result = await this.reports.run(saved.reportKey, branchId, fmt(from), fmt(to));
    return { saved, result };
  }

  async rules(branchId: string) {
    return this.prisma.automationRule.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addRule(
    branchId: string,
    input: {
      name: string;
      trigger: string;
      actions?: unknown;
      emailTo?: string;
      phoneTo?: string;
      webhookUrl?: string;
      taskTitle?: string;
      nextRuleId?: string;
    },
  ) {
    const data = await this.ruleData(branchId, null, input);
    return this.prisma.automationRule.create({ data: { branchId, ...data } });
  }

  async setRuleActive(branchId: string, id: string, active: boolean) {
    const row = await this.prisma.automationRule.findFirst({ where: { id, branchId } });
    if (!row) throw new NotFoundException('Rule not found');
    return this.prisma.automationRule.update({ where: { id }, data: { active } });
  }

  async tasks(branchId: string) {
    return this.prisma.automationTask.findMany({
      where: { branchId, doneAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { rule: { select: { name: true } } },
    });
  }

  async completeTask(branchId: string, id: string) {
    const row = await this.prisma.automationTask.findFirst({ where: { id, branchId, doneAt: null } });
    if (!row) throw new NotFoundException('Task not found');
    return this.prisma.automationTask.update({ where: { id }, data: { doneAt: new Date() } });
  }

  async bi(branchId: string) {
    const since = new Date(Date.now() - 13 * 86_400_000);
    since.setHours(0, 0, 0, 0);
    const orders = await this.prisma.order.findMany({
      where: { branchId, status: 'PAID', billedAt: { gte: since } },
      select: { billedAt: true, totalAmount: true, type: true },
    });
    const days = new Map<string, number>();
    const channels = new Map<string, number>();
    for (const order of orders) {
      const day = (order.billedAt ?? since).toISOString().slice(0, 10);
      days.set(day, (days.get(day) ?? 0) + Number(order.totalAmount));
      channels.set(order.type, (channels.get(order.type) ?? 0) + Number(order.totalAmount));
    }
    return {
      days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, sales]) => ({
        day,
        sales: sales.toFixed(2),
      })),
      channels: [...channels.entries()].map(([type, sales]) => ({ type, sales: sales.toFixed(2) })),
      orders: orders.length,
      sales: orders.reduce((sum, order) => sum + Number(order.totalAmount), 0).toFixed(2),
    };
  }

  async conflicts(branchId: string) {
    return this.prisma.offlineConflict.findMany({
      where: { branchId, resolvedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async resolveConflict(branchId: string, id: string) {
    const row = await this.prisma.offlineConflict.findFirst({ where: { id, branchId } });
    if (!row) throw new NotFoundException('Conflict not found');
    return this.prisma.offlineConflict.update({
      where: { id },
      data: { resolvedAt: new Date() },
    });
  }

  @Cron('0 */5 * * * *')
  async runAutomations() {
    const rules = await this.prisma.automationRule.findMany({
      where: { active: true },
      include: { branch: { select: { restaurantId: true } } },
    });
    const fired = new Set<string>();
    for (const rule of rules) {
      if (fired.has(rule.id)) continue;
      const body = await this.ruleMessage(rule);
      if (!body) continue;
      await this.fireRule(rule, body, fired, 0);
    }
  }

  private async ruleMessage(rule: {
    id: string;
    branchId: string;
    trigger: string;
    lastFiredAt: Date | null;
  }) {
    const since = rule.lastFiredAt ?? new Date(Date.now() - 5 * 60_000);
    if (rule.trigger === 'ORDER_PAID') {
      const count = await this.prisma.order.count({
        where: { branchId: rule.branchId, status: 'PAID', billedAt: { gt: since } },
      });
      return count > 0 ? `${count} bill${count === 1 ? '' : 's'} paid since the last check` : null;
    }
    if (rule.trigger === 'LOW_STOCK') {
      if (rule.lastFiredAt && Date.now() - rule.lastFiredAt.getTime() < 12 * 60 * 60_000) return null;
      const low = await this.prisma.ingredient.findMany({
        where: { branchId: rule.branchId, isActive: true, reorderLevel: { gt: 0 } },
        select: { name: true, currentStock: true, reorderLevel: true },
      });
      const names = low
        .filter((row) => Number(row.currentStock) <= Number(row.reorderLevel))
        .map((row) => row.name);
      return names.length ? `Low stock: ${names.slice(0, 8).join(', ')}` : null;
    }
    if (rule.trigger === 'RESERVATION_TODAY') {
      const today = new Date().toISOString().slice(0, 10);
      if (rule.lastFiredAt && rule.lastFiredAt.toISOString().slice(0, 10) === today) return null;
      const start = new Date(`${today}T00:00:00.000Z`);
      const end = new Date(start.getTime() + 86_400_000);
      const count = await this.prisma.reservation.count({
        where: {
          branchId: rule.branchId,
          reservedAt: { gte: start, lt: end },
          status: { in: ['RESERVED', 'CONFIRMED'] },
        },
      });
      return count > 0 ? `${count} reservation${count === 1 ? '' : 's'} on the book today` : null;
    }
    return null;
  }

  private async ruleData(
    branchId: string,
    ruleId: string | null,
    input: {
      name: string;
      trigger: string;
      actions?: unknown;
      emailTo?: string;
      phoneTo?: string;
      webhookUrl?: string;
      taskTitle?: string;
      nextRuleId?: string;
    },
  ) {
    if (!TRIGGERS.includes(input.trigger as (typeof TRIGGERS)[number])) {
      throw new BadRequestException('Trigger must be ORDER_PAID, LOW_STOCK, or RESERVATION_TODAY');
    }
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new BadRequestException('Give the rule a name');
    const actions = normalizeActions(input.actions);
    const emailTo = input.emailTo?.trim().slice(0, 160) || null;
    const phoneTo = input.phoneTo?.trim().slice(0, 20) || null;
    const webhookUrl = input.webhookUrl?.trim().slice(0, 400) || null;
    const taskTitle = input.taskTitle?.trim().slice(0, 80) || null;
    const nextRuleId = input.nextRuleId?.trim() || null;
    if (actions.includes('EMAIL') && emailTo && !emailTo.includes('@')) {
      throw new BadRequestException('Enter an email address for this rule');
    }
    if (actions.includes('WEBHOOK')) {
      if (!webhookUrl) throw new BadRequestException('Enter the webhook URL for this rule');
      let parsed: URL;
      try {
        parsed = new URL(webhookUrl);
      } catch {
        throw new BadRequestException('The webhook URL is not valid');
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new BadRequestException('The webhook URL must start with http or https');
      }
    }
    if (actions.includes('CHAIN')) {
      if (!nextRuleId || nextRuleId === ruleId) {
        throw new BadRequestException('Choose a different rule to run next');
      }
      const next = await this.prisma.automationRule.findFirst({ where: { id: nextRuleId, branchId } });
      if (!next) throw new BadRequestException('The next rule is not on this branch');
      const rows = await this.prisma.automationRule.findMany({
        where: { branchId },
        select: { id: true, nextRuleId: true },
      });
      const nextOf = new Map(rows.map((row) => [row.id, row.nextRuleId]));
      if (ruleId) nextOf.set(ruleId, nextRuleId);
      else nextOf.set('new', nextRuleId);
      if (chainLoops(ruleId ?? 'new', (id) => nextOf.get(id) ?? null)) {
        throw new BadRequestException('These rules would call each other in a circle');
      }
    }
    return {
      name,
      trigger: input.trigger,
      actions,
      emailTo,
      phoneTo,
      webhookUrl,
      taskTitle,
      nextRuleId: actions.includes('CHAIN') ? nextRuleId : null,
    };
  }

  private async fireRule(
    rule: {
      id: string;
      branchId: string;
      name: string;
      trigger: string;
      actions: unknown;
      emailTo: string | null;
      phoneTo: string | null;
      webhookUrl: string | null;
      taskTitle: string | null;
      nextRuleId: string | null;
      branch: { restaurantId: string };
    },
    body: string,
    fired: Set<string>,
    depth: number,
  ) {
    if (fired.has(rule.id) || depth > 3) return;
    fired.add(rule.id);
    const actions = normalizeActions(rule.actions);
    const owner = await this.prisma.user.findFirst({
      where: { restaurantId: rule.branch.restaurantId, isActive: true, role: { name: 'OWNER' } },
      select: { id: true, email: true, phone: true },
    });
    const errors: string[] = [];
    for (const action of actions) {
      try {
        await this.runAction(rule, action, body, owner);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${action}: ${message}`);
        this.logger.warn(`Rule ${rule.id} ${action} failed: ${message}`);
      }
    }
    await this.prisma.automationRule.update({
      where: { id: rule.id },
      data: { lastFiredAt: new Date(), lastError: errors.join('; ').slice(0, 500) || null },
    });
    if (!actions.includes('CHAIN') || !rule.nextRuleId || depth >= 3) return;
    const next = await this.prisma.automationRule.findFirst({
      where: { id: rule.nextRuleId, branchId: rule.branchId, active: true },
      include: { branch: { select: { restaurantId: true } } },
    });
    if (next) await this.fireRule(next, body, fired, depth + 1);
  }

  private async runAction(
    rule: {
      id: string;
      branchId: string;
      name: string;
      trigger: string;
      emailTo: string | null;
      phoneTo: string | null;
      webhookUrl: string | null;
      taskTitle: string | null;
      branch: { restaurantId: string };
    },
    action: AutomationAction,
    body: string,
    owner: { id: string; email: string | null; phone: string | null } | null,
  ) {
    if (action === 'NOTIFY') {
      if (!owner) throw new Error('No active owner to notify');
      await this.notifications.notifyUser(owner.id, rule.branchId, {
        type: 'automation.fired',
        title: rule.name,
        body,
        entity: 'AutomationRule',
        entityId: rule.id,
      });
      return;
    }
    if (action === 'EMAIL') {
      const to = rule.emailTo || owner?.email;
      if (!to) throw new Error('No email address on the rule or the owner');
      await this.email.send({ to, subject: rule.name, text: body }, rule.branch.restaurantId);
      return;
    }
    if (action === 'SMS' || action === 'WHATSAPP') {
      const to = rule.phoneTo || owner?.phone;
      if (!to) throw new Error('No phone number on the rule or the owner');
      await this.messaging.dispatch({
        restaurantId: rule.branch.restaurantId,
        branchId: rule.branchId,
        channel: action,
        purpose: 'AUTOMATION',
        to,
        body: `${rule.name}: ${body}`,
      });
      return;
    }
    if (action === 'WEBHOOK') {
      await this.webhooks.emit(rule.branch.restaurantId, 'automation.fired', {
        ruleId: rule.id,
        name: rule.name,
        trigger: rule.trigger,
        message: body,
      });
      if (!rule.webhookUrl) return;
      const target = await resolveWebhookTarget(rule.webhookUrl, netOptionsFromEnv());
      const response = await fetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ruleId: rule.id,
          name: rule.name,
          trigger: rule.trigger,
          message: body,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
      return;
    }
    if (action === 'TASK') {
      await this.prisma.automationTask.create({
        data: {
          branchId: rule.branchId,
          ruleId: rule.id,
          title: rule.taskTitle || rule.name,
          body,
        },
      });
    }
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async deviceByToken(token: string | undefined) {
    if (!token) throw new UnauthorizedException('Missing device token');
    const row = await this.prisma.posDevice.findUnique({ where: { tokenHash: this.hashToken(token) } });
    if (!row) throw new UnauthorizedException('Unknown device');
    return row;
  }
}

function header(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || '';
}
