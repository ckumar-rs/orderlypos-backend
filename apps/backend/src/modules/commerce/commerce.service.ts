import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openSecret, sealSecret } from '../../auth/totp';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { DeliveryService } from '../delivery/delivery.service';
import {
  isPaidStatus,
  readGatewayRef,
  secretsMatch,
  signaturesMatch,
} from './commerce-verify';

export const GATEWAY_PROVIDERS = ['RAZORPAY', 'PHONEPE', 'PAYTM', 'STRIPE'] as const;
export const EDC_PROVIDERS = ['PINELABS', 'MOSAMBEE', 'MSWIPE', 'PAX'] as const;
export const FLEET_PROVIDERS = ['RAPIDO', 'DUNZO', 'SHADOWFAX'] as const;

@Injectable()
export class CommerceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly orders: OrdersService,
    private readonly delivery: DeliveryService,
  ) {}

  listGateways(restaurantId: string) {
    return this.prisma.paymentGateway.findMany({
      where: { restaurantId },
      orderBy: { provider: 'asc' },
    }).then((rows) =>
      GATEWAY_PROVIDERS.map((provider) => {
        const row = rows.find((item) => item.provider === provider);
        return {
          provider,
          enabled: row?.enabled ?? false,
          baseUrl: row?.baseUrl ?? null,
          keyId: row?.keyId ?? null,
          secretConfigured: Boolean(row?.secretSealed),
          webhookSecretConfigured: Boolean(row?.webhookSecretSealed),
          webhookPath: `/api/v1/public/payments/${provider.toLowerCase()}`,
        };
      }),
    );
  }

  async saveGateway(
    restaurantId: string,
    provider: string,
    dto: {
      enabled: boolean;
      baseUrl?: string | null;
      keyId?: string | null;
      secret?: string | null;
      webhookSecret?: string | null;
    },
  ) {
    const name = this.oneOf(provider, GATEWAY_PROVIDERS, 'Gateway');
    const existing = await this.prisma.paymentGateway.findUnique({
      where: { restaurantId_provider: { restaurantId, provider: name } },
    });
    const data = {
      enabled: dto.enabled,
      baseUrl: blank(dto.baseUrl),
      keyId: blank(dto.keyId),
      ...(dto.secret ? { secretSealed: sealSecret(dto.secret, this.key()) } : {}),
      ...(dto.webhookSecret
        ? { webhookSecretSealed: sealSecret(dto.webhookSecret, this.key()) }
        : {}),
    };
    if (existing) {
      await this.prisma.paymentGateway.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.paymentGateway.create({
        data: { restaurantId, provider: name, ...data },
      });
    }
    return this.listGateways(restaurantId);
  }

  async createIntent(branchId: string, restaurantId: string, orderId: string, provider: string, amount: number) {
    const name = this.oneOf(provider, GATEWAY_PROVIDERS, 'Gateway');
    const gateway = await this.requireGateway(restaurantId, name);
    const order = await this.openOrder(branchId, orderId);
    const intent = await this.prisma.paymentIntent.create({
      data: { branchId, orderId: order.id, provider: name, amount, status: 'PENDING' },
    });
    const remote = await this.postJson(gateway.baseUrl!, gateway.secret, gateway.keyId, {
      amount,
      currency: 'INR',
      receipt: order.orderNumber,
      intentId: intent.id,
      orderId: order.id,
      notes: { intentId: intent.id },
    });
    const parsed = readGatewayRef(remote);
    const updated = await this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        gatewayRef: parsed.refs[0] ?? intent.id,
        checkoutUrl: parsed.url,
      },
    });
    return updated;
  }

  async handleGatewayWebhook(
    provider: string,
    raw: Buffer,
    body: unknown,
    signature: string | undefined,
    secretHeader: string | undefined,
  ) {
    const name = this.oneOf(provider, GATEWAY_PROVIDERS, 'Gateway');
    const parsed = readGatewayRef(body);
    const intent = await this.prisma.paymentIntent.findFirst({
      where: {
        provider: name,
        OR: [
          { id: { in: parsed.refs } },
          { gatewayRef: { in: parsed.refs.length ? parsed.refs : ['__none__'] } },
        ],
      },
      include: { order: { include: { branch: true } } },
    });
    if (!intent) throw new NotFoundException('Payment intent not found');
    const gateway = await this.requireGateway(intent.order.branch.restaurantId, name);
    const webhookSecret = gateway.webhookSecret;
    if (!webhookSecret) {
      throw new BadRequestException('Store a webhook secret before accepting callbacks');
    }
    const ok =
      signaturesMatch(webhookSecret, raw, signature) || secretsMatch(webhookSecret, secretHeader);
    if (!ok) throw new BadRequestException('Webhook signature did not match');
    if (intent.status === 'PAID') return { ok: true, duplicate: true };
    if (!isPaidStatus(parsed.status) && !isPaidStatus(String((body as { event?: string }).event ?? ''))) {
      await this.prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'FAILED', utr: parsed.utr },
      });
      return { ok: true, paid: false };
    }
    await this.orders.checkout(intent.branchId, intent.orderId, intent.order.createdById, {
      payments: [
        {
          method: name === 'STRIPE' ? 'CARD' : 'UPI',
          amount: Number(intent.amount),
          reference: parsed.utr ?? intent.gatewayRef ?? intent.id,
        },
      ],
      allowPartial: false,
      requestId: `gw${intent.id}`.slice(0, 64),
    });
    await this.prisma.payment.updateMany({
      where: { orderId: intent.orderId, reference: parsed.utr ?? intent.gatewayRef ?? intent.id },
      data: { gatewayProvider: name, utr: parsed.utr },
    });
    await this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: 'PAID', paidAt: new Date(), utr: parsed.utr },
    });
    return { ok: true, paid: true };
  }

  async handleEdcWebhook(
    provider: string,
    raw: Buffer,
    body: unknown,
    signature: string | undefined,
    secretHeader: string | undefined,
  ) {
    const name = this.oneOf(provider, EDC_PROVIDERS, 'Terminal');
    const parsed = readGatewayRef(body);
    const intent = await this.prisma.paymentIntent.findFirst({
      where: {
        provider: name,
        OR: [
          { id: { in: parsed.refs } },
          { gatewayRef: { in: parsed.refs.length ? parsed.refs : ['__none__'] } },
        ],
      },
      include: { order: true },
    });
    if (!intent) throw new NotFoundException('Terminal payment not found');
    if (intent.status === 'PAID') return { ok: true, duplicate: true };
    const terminals = await this.prisma.edcTerminal.findMany({
      where: { branchId: intent.branchId, provider: name, enabled: true },
    });
    const ok = terminals.some((terminal) => {
      if (!terminal.secretSealed) return false;
      const secret = openSecret(terminal.secretSealed, this.key());
      return signaturesMatch(secret, raw, signature) || secretsMatch(secret, secretHeader);
    });
    if (!ok) throw new BadRequestException('Terminal webhook did not match a stored secret');
    if (!isPaidStatus(parsed.status)) {
      await this.prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'FAILED', utr: parsed.utr },
      });
      return { ok: true, paid: false };
    }
    const reference = parsed.utr ?? intent.gatewayRef ?? intent.id;
    await this.orders.checkout(intent.branchId, intent.orderId, intent.order.createdById, {
      payments: [{ method: 'CARD', amount: Number(intent.amount), reference }],
      allowPartial: false,
      requestId: `edc${intent.id}`.slice(0, 64),
    });
    await this.prisma.payment.updateMany({
      where: { orderId: intent.orderId, reference },
      data: { gatewayProvider: name, utr: parsed.utr },
    });
    await this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: 'PAID', paidAt: new Date(), utr: parsed.utr },
    });
    return { ok: true, paid: true };
  }

  listTerminals(branchId: string) {
    return this.prisma.edcTerminal.findMany({
      where: { branchId },
      orderBy: { name: 'asc' },
    }).then((rows) =>
      rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        name: row.name,
        enabled: row.enabled,
        baseUrl: row.baseUrl,
        merchantId: row.merchantId,
        terminalId: row.terminalId,
        secretConfigured: Boolean(row.secretSealed),
      })),
    );
  }

  async saveTerminal(
    branchId: string,
    dto: {
      id?: string;
      provider: string;
      name: string;
      enabled: boolean;
      baseUrl?: string | null;
      merchantId?: string | null;
      terminalId?: string | null;
      secret?: string | null;
    },
  ) {
    const provider = this.oneOf(dto.provider, EDC_PROVIDERS, 'Terminal');
    const data = {
      provider,
      name: dto.name.trim(),
      enabled: dto.enabled,
      baseUrl: blank(dto.baseUrl),
      merchantId: blank(dto.merchantId),
      terminalId: blank(dto.terminalId),
      ...(dto.secret ? { secretSealed: sealSecret(dto.secret, this.key()) } : {}),
    };
    if (dto.id) {
      const existing = await this.prisma.edcTerminal.findFirst({ where: { id: dto.id, branchId } });
      if (!existing) throw new NotFoundException('Terminal not found');
      return this.prisma.edcTerminal.update({ where: { id: existing.id }, data });
    }
    return this.prisma.edcTerminal.create({ data: { branchId, ...data } });
  }

  async pushToTerminal(branchId: string, terminalId: string, orderId: string, amount: number) {
    const terminal = await this.prisma.edcTerminal.findFirst({ where: { id: terminalId, branchId } });
    if (!terminal?.enabled || !terminal.baseUrl || !terminal.secretSealed) {
      throw new BadRequestException('Turn the terminal on and store its URL and secret');
    }
    const order = await this.openOrder(branchId, orderId);
    const secret = openSecret(terminal.secretSealed, this.key());
    const remote = await this.postJson(terminal.baseUrl, secret, terminal.terminalId, {
      amount,
      orderNumber: order.orderNumber,
      orderId: order.id,
      merchantId: terminal.merchantId,
      terminalId: terminal.terminalId,
    });
    const parsed = readGatewayRef(remote);
    return this.prisma.paymentIntent.create({
      data: {
        branchId,
        orderId: order.id,
        provider: terminal.provider,
        amount,
        status: 'PENDING',
        gatewayRef: parsed.refs[0] ?? null,
      },
    });
  }

  async listHouse(branchId: string) {
    const rows = await this.prisma.houseAccount.findMany({
      where: { branchId },
      include: { customer: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      notes: row.notes,
      customerId: row.customerId,
      customerName: row.customer?.name ?? null,
      creditLimit: Number(row.creditLimit),
      balance: Number(row.balance),
    }));
  }

  createHouse(
    branchId: string,
    dto: { name: string; customerId?: string | null; creditLimit?: number; notes?: string | null },
  ) {
    return this.prisma.houseAccount.create({
      data: {
        branchId,
        name: dto.name.trim(),
        customerId: dto.customerId || null,
        creditLimit: dto.creditLimit ?? 0,
        notes: blank(dto.notes),
      },
    });
  }

  async updateHouse(
    branchId: string,
    id: string,
    dto: { name: string; customerId?: string | null; creditLimit?: number; notes?: string | null },
  ) {
    const existing = await this.prisma.houseAccount.findFirst({ where: { id, branchId } });
    if (!existing) throw new NotFoundException('House account not found');
    await this.prisma.houseAccount.update({
      where: { id: existing.id },
      data: {
        name: dto.name.trim(),
        customerId: dto.customerId || null,
        creditLimit: dto.creditLimit ?? Number(existing.creditLimit),
        notes: blank(dto.notes),
      },
    });
    return this.listHouse(branchId);
  }

  async postHouse(
    branchId: string,
    userId: string,
    accountId: string,
    dto: { kind: 'ADVANCE' | 'CHARGE'; amount: number; reference?: string; orderId?: string; reservationId?: string },
  ) {
    const account = await this.prisma.houseAccount.findFirst({ where: { id: accountId, branchId } });
    if (!account) throw new NotFoundException('House account not found');
    const signed = dto.kind === 'CHARGE' ? -Math.abs(dto.amount) : Math.abs(dto.amount);
    const next = Number(account.balance) + signed;
    if (next < -Number(account.creditLimit)) {
      throw new BadRequestException('This would exceed the house credit limit');
    }
    if (dto.kind === 'CHARGE' && dto.orderId) {
      await this.orders.checkout(branchId, dto.orderId, userId, {
        payments: [{ method: 'STORE_CREDIT', amount: Math.abs(dto.amount), reference: account.name }],
        allowPartial: true,
        requestId: `ha${account.id}${dto.orderId ?? 'ledger'}`.slice(0, 64),
      });
    }
    if (dto.reservationId && dto.kind === 'ADVANCE') {
      await this.prisma.reservation.updateMany({
        where: { id: dto.reservationId, branchId },
        data: {
          deposit: Math.abs(dto.amount),
          depositPaid: true,
          depositReference: dto.reference ?? account.name,
        },
      });
    }
    await this.prisma.houseAccount.update({
      where: { id: account.id },
      data: { balance: next },
    });
    return this.prisma.houseAccountEntry.create({
      data: {
        houseAccountId: account.id,
        kind: dto.kind,
        amount: signed,
        reference: dto.reference,
        orderId: dto.orderId,
        reservationId: dto.reservationId,
        createdById: userId,
      },
    });
  }

  listFleet(branchId: string) {
    return this.prisma.fleetAccount.findMany({ where: { branchId } }).then((rows) =>
      FLEET_PROVIDERS.map((provider) => {
        const row = rows.find((item) => item.provider === provider);
        return {
          provider,
          enabled: row?.enabled ?? false,
          baseUrl: row?.baseUrl ?? null,
          apiKeyConfigured: Boolean(row?.apiKeySealed),
          webhookPath: `/api/v1/public/fleet/${provider.toLowerCase()}`,
        };
      }),
    );
  }

  async saveFleet(
    branchId: string,
    provider: string,
    dto: { enabled: boolean; baseUrl?: string | null; apiKey?: string | null },
  ) {
    const name = this.oneOf(provider, FLEET_PROVIDERS, 'Fleet');
    const existing = await this.prisma.fleetAccount.findUnique({
      where: { branchId_provider: { branchId, provider: name } },
    });
    const data = {
      enabled: dto.enabled,
      baseUrl: blank(dto.baseUrl),
      ...(dto.apiKey ? { apiKeySealed: sealSecret(dto.apiKey, this.key()) } : {}),
    };
    if (existing) await this.prisma.fleetAccount.update({ where: { id: existing.id }, data });
    else await this.prisma.fleetAccount.create({ data: { branchId, provider: name, ...data } });
    return this.listFleet(branchId);
  }

  async dispatch(branchId: string, orderId: string, provider: string) {
    const name = this.oneOf(provider, FLEET_PROVIDERS, 'Fleet');
    const account = await this.prisma.fleetAccount.findUnique({
      where: { branchId_provider: { branchId, provider: name } },
    });
    if (!account?.enabled || !account.baseUrl || !account.apiKeySealed) {
      throw new BadRequestException('Turn the fleet on and store its URL and key');
    }
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId, type: 'DELIVERY' },
      include: { branch: true },
    });
    if (!order) throw new NotFoundException('Delivery order not found');
    const key = openSecret(account.apiKeySealed, this.key());
    const remote = await this.postJson(account.baseUrl, key, null, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      pickupAddress: order.branch.address,
      dropAddress: order.deliveryAddress,
      phone: order.deliveryPhone,
      pincode: order.deliveryPincode,
    });
    const parsed = readGatewayRef(remote);
    return this.prisma.fleetJob.create({
      data: {
        orderId: order.id,
        provider: name,
        externalId: parsed.refs[0] ?? null,
        status: 'REQUESTED',
      },
    });
  }

  async handleFleetWebhook(provider: string, body: unknown, secretHeader: string | undefined) {
    const name = this.oneOf(provider, FLEET_PROVIDERS, 'Fleet');
    const parsed = readGatewayRef(body);
    const job = await this.prisma.fleetJob.findFirst({
      where: {
        provider: name,
        OR: [
          { externalId: { in: parsed.refs.length ? parsed.refs : ['__none__'] } },
          { orderId: { in: parsed.refs } },
        ],
      },
      include: { order: true },
    });
    if (!job) throw new NotFoundException('Fleet job not found');
    const account = await this.prisma.fleetAccount.findUnique({
      where: { branchId_provider: { branchId: job.order.branchId, provider: name } },
    });
    if (!account?.apiKeySealed) throw new BadRequestException('Fleet key is not stored');
    const key = openSecret(account.apiKeySealed, this.key());
    if (!secretHeader || !safeEqual(key, secretHeader)) {
      throw new BadRequestException('Fleet webhook key did not match');
    }
    const status = (parsed.status ?? 'UPDATED').toUpperCase();
    await this.prisma.fleetJob.update({ where: { id: job.id }, data: { status } });
    const deliveryStatus = status.includes('DELIVER')
      ? 'DELIVERED'
      : status.includes('PICK')
        ? 'PICKED_UP'
        : status.includes('ASSIGN')
          ? 'ASSIGNED'
          : null;
    if (deliveryStatus && job.order.deliveryStatus !== deliveryStatus) {
      try {
        await this.delivery.setStatus(job.order.branchId, job.orderId, deliveryStatus);
      } catch {
        // Status order is enforced by the existing delivery flow.
      }
    }
    return { ok: true };
  }

  private async requireGateway(restaurantId: string, provider: string) {
    const row = await this.prisma.paymentGateway.findUnique({
      where: { restaurantId_provider: { restaurantId, provider } },
    });
    if (!row?.enabled || !row.baseUrl || !row.secretSealed) {
      throw new BadRequestException('Turn the gateway on and store its URL and secret');
    }
    return {
      ...row,
      secret: openSecret(row.secretSealed, this.key()),
      webhookSecret: row.webhookSecretSealed
        ? openSecret(row.webhookSecretSealed, this.key())
        : null,
    };
  }

  private async openOrder(branchId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, branchId, status: 'OPEN' } });
    if (!order) throw new BadRequestException('Order is not open');
    return order;
  }

  private async postJson(url: string, secret: string, keyId: string | null, body: unknown) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        ...(keyId ? { 'X-Api-Key': keyId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const message = typeof json?.message === 'string' ? json.message : `HTTP ${response.status}`;
      throw new BadRequestException(message);
    }
    return json ?? {};
  }

  private oneOf<T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
    const name = value.trim().toUpperCase();
    if (!(allowed as readonly string[]).includes(name)) {
      throw new BadRequestException(`${label} must be one of ${allowed.join(', ')}`);
    }
    return name;
  }

  private key() {
    return this.config.get<string>('WEBHOOK_KEY') ?? this.config.get<string>('JWT_SECRET') ?? '';
  }
}

function blank(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
