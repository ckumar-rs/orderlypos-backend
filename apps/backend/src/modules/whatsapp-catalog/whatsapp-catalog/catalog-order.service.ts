import { BadRequestException, Inject, Injectable, Logger, PayloadTooLargeException, UnauthorizedException, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import QRCode from 'qrcode';
import { openSecret } from '../../auth/totp';
import { buildUpiUri } from '../../common/upi';
import { PrismaService } from '../../prisma/prisma.service';
import { whatsappCatalogMessagePayload, whatsappDocumentPayload, whatsappImagePayload, whatsappMediaUrl, whatsappMessagesUrl, whatsappTextPayload } from '../messaging/messaging';
import { buildReceiptPdf } from '../orders/receipt-pdf';
import { OrdersService } from '../orders/orders.service';
import {
  CatalogInbound,
  catalogBrowseReply,
  catalogOrderReply,
  menuItemIdFromRetailer,
  parseCloudWebhook,
  planCatalogCart,
  requestIdForMessage,
} from './catalog-order';
import { planSpokenOrder, transcriptFromWhisper, voiceFilename } from './spoken-order';
import { catalogLifecycle, verifyMetaSignature, CATALOG_GRAPH_VERSION } from './catalog';

const MAX_WEBHOOK_BYTES = 262144;

@Injectable()
export class CatalogOrderService {
  private readonly logger = new Logger(CatalogOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async pushPending() {
    try {
      await this.processPending();
      await this.sendDueReceipts();
    } catch (err) {
      this.logger.warn(`Catalog orders skipped: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  async receive(raw: Buffer, header: string | undefined, body: unknown) {
    if (raw.length > MAX_WEBHOOK_BYTES) {
      throw new PayloadTooLargeException('WhatsApp webhook is too large');
    }
    const secret = this.config.get<string>('META_APP_SECRET') ?? '';
    if (!verifyMetaSignature(raw, header, secret)) {
      throw new UnauthorizedException('WhatsApp signature did not match');
    }
    await this.noteConnection(catalogLifecycle(body));
    for (const event of parseCloudWebhook(body)) {
      try {
        await this.prisma.whatsAppCatalogEvent.create({
          data: {
            provider: 'META',
            providerEventId: event.providerEventId,
            phoneNumberId: event.phoneNumberId,
            eventType: event.eventType,
            payload: event as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      }
    }
    void this.processPending().catch((err) => {
      this.logger.warn(`Catalog orders skipped: ${err instanceof Error ? err.message : 'unknown'}`);
    });
    return { ok: true as const };
  }

  async processPending() {
    const due = await this.prisma.whatsAppCatalogEvent.findMany({
      where: { processingStatus: { in: ['RECEIVED', 'FAILED'] }, attempts: { lt: 5 } },
      orderBy: { receivedAt: 'asc' },
      take: 20,
    });
    for (const row of due) {
      const claim = await this.prisma.whatsAppCatalogEvent.updateMany({
        where: { id: row.id, processingStatus: { in: ['RECEIVED', 'FAILED'] } },
        data: { processingStatus: 'PROCESSING' },
      });
      if (claim.count !== 1) continue;
      try {
        const note = await this.handle(row.payload);
        await this.prisma.whatsAppCatalogEvent.update({
          where: { id: row.id },
          data: { processingStatus: 'PROCESSED', processedAt: new Date(), lastError: note },
        });
      } catch (err) {
        await this.prisma.whatsAppCatalogEvent.update({
          where: { id: row.id },
          data: {
            processingStatus: 'FAILED',
            attempts: row.attempts + 1,
            lastError: (err instanceof Error ? err.message : 'Could not process').slice(0, 300),
          },
        });
      }
    }
  }

  private async handle(payload: Prisma.JsonValue): Promise<string | null> {
    const inbound = asInbound(payload);
    if (!inbound || inbound.eventType === 'STATUS' || inbound.eventType === 'OTHER') return null;
    const connection = await this.prisma.whatsAppCatalogConnection.findUnique({
      where: { phoneNumberId: inbound.phoneNumberId },
    });
    if (!connection || connection.connectionStatus !== 'CONNECTED' || !inbound.from) {
      return 'No connected catalog for this phone number';
    }
    if (inbound.eventType === 'VOICE') return this.placeSpoken(connection, inbound);
    if (inbound.eventType === 'TEXT' || inbound.eventType === 'PROMPT') {
      await this.sendCloud(
        connection,
        inbound.from,
        whatsappCatalogMessagePayload(inbound.from, catalogBrowseReply()),
      );
      return null;
    }
    return this.placeOrder(connection, inbound);
  }

  private async placeSpoken(
    connection: {
      restaurantId: string;
      branchId: string;
      phoneNumberId: string;
      accessTokenSealed: string | null;
    },
    inbound: CatalogInbound,
  ): Promise<string | null> {
    if (!inbound.from || !inbound.mediaId) {
      await this.reject(connection, inbound, 'Send the dishes as a voice note, or add them from the menu.');
      return null;
    }
    const apiKey = (this.config.get<string>('OPENAI_API_KEY') ?? '').trim();
    if (!apiKey) {
      await this.sendCloud(
        connection,
        inbound.from,
        whatsappCatalogMessagePayload(
          inbound.from,
          'I received a voice note. Voice ordering is not turned on yet. Browse the menu and add the dishes.',
        ),
      );
      return 'Speech is not configured';
    }
    const audio = await this.downloadVoice(connection, inbound.mediaId);
    const transcript = await this.transcribe(apiKey, audio.bytes, audio.mime);
    const menu = await this.prisma.menuItem.findMany({
      where: { branchId: connection.branchId },
      select: { id: true, name: true, isActive: true, soldByWeight: true },
      take: 400,
    });
    const groups = menu.length
      ? await this.prisma.menuItemModifierGroup.findMany({
          where: { menuItemId: { in: menu.map((item) => item.id) }, modifierGroup: { branchId: connection.branchId } },
          include: { modifierGroup: { select: { isRequired: true, minSelect: true } } },
        })
      : [];
    const needsChoice = new Set(
      groups
        .filter((group) => group.modifierGroup.isRequired || group.modifierGroup.minSelect > 0)
        .map((group) => group.menuItemId),
    );
    const plan = planSpokenOrder(
      transcript,
      menu.map((item) => ({
        retailerId: `item_${item.id}`,
        menuItemId: item.id,
        name: item.name,
        isActive: item.isActive,
        soldByWeight: item.soldByWeight,
        requiresModifier: needsChoice.has(item.id),
      })),
    );
    if (!plan.ok) {
      const heard = transcript.replace(/\s+/g, ' ').slice(0, 120);
      await this.reject(connection, inbound, `${plan.reason} I heard: ${heard}`);
      return null;
    }
    return this.placeOrder(connection, {
      ...inbound,
      text: transcript.slice(0, 400),
      items: plan.items.map((item) => ({
        retailerId: `item_${item.menuItemId}`,
        quantity: item.quantity,
        submittedPrice: null,
        currency: null,
      })),
    });
  }

  private async downloadVoice(
    connection: { accessTokenSealed: string | null },
    mediaId: string,
  ): Promise<{ bytes: Buffer; mime: string }> {
    if (!connection.accessTokenSealed) throw new Error('Paste the access token');
    const token = openSecret(connection.accessTokenSealed, this.keyMaterial());
    const lookup = await fetch(`${this.graphBase()}/${mediaId}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const info = (await lookup.json().catch(() => null)) as { url?: string; mime_type?: string } | null;
    if (!lookup.ok || !info?.url) throw new Error(`WhatsApp returned ${lookup.status}`);
    const file = await fetch(info.url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!file.ok) throw new Error(`WhatsApp returned ${file.status}`);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length < 1 || bytes.length > 8_000_000) throw new Error('Voice note is too large');
    return { bytes, mime: info.mime_type || 'audio/ogg' };
  }

  private async transcribe(apiKey: string, audio: Buffer, mime: string): Promise<string> {
    const root = (this.config.get<string>('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const form = new FormData();
    form.set('model', 'whisper-1');
    form.set('file', new Blob([new Uint8Array(audio)], { type: mime.split(';')[0] || 'audio/ogg' }), voiceFilename(mime));
    const response = await fetch(`${root}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const json = await response.json().catch(() => null);
    return transcriptFromWhisper(response.status, json);
  }

  private async placeOrder(
    connection: {
      restaurantId: string;
      branchId: string;
      phoneNumberId: string;
      accessTokenSealed: string | null;
    },
    inbound: CatalogInbound,
  ): Promise<string | null> {
    const existing = await this.prisma.whatsAppCatalogSubmission.findUnique({
      where: { branchId_messageId: { branchId: connection.branchId, messageId: inbound.providerEventId } },
    });
    if (existing && (existing.submissionStatus === 'ORDERED' || existing.submissionStatus === 'REJECTED')) {
      return null;
    }
    const branch = await this.prisma.branch.findUnique({
      where: { id: connection.branchId },
      select: {
        onlineOrdersPaused: true,
        restaurant: { select: { name: true, currency: true, upiVpa: true, upiPayeeName: true } },
      },
    });
    if (!branch) return 'Branch not found';
    if (branch.onlineOrdersPaused) {
      await this.reject(connection, inbound, 'The kitchen has paused online orders.');
      return null;
    }
    const menuItemIds = [
      ...new Set(inbound.items.map((line) => menuItemIdFromRetailer(line.retailerId)).filter((id): id is string => Boolean(id))),
    ];
    const menu = menuItemIds.length
      ? await this.prisma.menuItem.findMany({
          where: { branchId: connection.branchId, id: { in: menuItemIds } },
          select: { id: true, name: true, isActive: true, soldByWeight: true },
        })
      : [];
    const groups = menu.length
      ? await this.prisma.menuItemModifierGroup.findMany({
          where: { menuItemId: { in: menu.map((item) => item.id) }, modifierGroup: { branchId: connection.branchId } },
          include: { modifierGroup: { select: { isRequired: true, minSelect: true } } },
        })
      : [];
    const needsChoice = new Set(
      groups
        .filter((group) => group.modifierGroup.isRequired || group.modifierGroup.minSelect > 0)
        .map((group) => group.menuItemId),
    );
    const plan = planCatalogCart(
      inbound.items,
      menu.map((item) => ({
        retailerId: `item_${item.id}`,
        menuItemId: item.id,
        name: item.name,
        isActive: item.isActive,
        soldByWeight: item.soldByWeight,
        requiresModifier: needsChoice.has(item.id),
      })),
    );
    if (!plan.ok) {
      await this.reject(connection, inbound, plan.reason);
      return null;
    }
    const staff = await this.prisma.userBranch.findFirst({
      where: { branchId: connection.branchId },
      select: { userId: true },
    });
    if (!staff) throw new Error('This branch has no staff user to own the order');
    const customer = await this.customerFor(connection.branchId, inbound);
    const requestId = requestIdForMessage(inbound.providerEventId);
    try {
      const order = await this.orders.createOrder(
        connection.branchId,
        staff.userId,
        {
          type: 'TAKEAWAY',
          customerId: customer.id,
          guestName: (inbound.name || 'WhatsApp').slice(0, 60),
          notes: [
            inbound.eventType === 'VOICE' ? 'WhatsApp voice' : 'WhatsApp catalog',
            inbound.catalogId,
            inbound.text,
          ]
            .filter(Boolean)
            .join(' ')
            .slice(0, 500),
          clientRequestId: requestId,
          items: plan.items,
        },
        { channel: 'STAFF', requireAcceptance: true },
      );
      await this.prisma.order.update({ where: { id: order.id }, data: { source: 'WHATSAPP' } });
      await this.saveSubmission(connection, inbound, {
        submissionStatus: 'ORDERED',
        orderId: order.id,
        customerId: customer.id,
        validatedCart: plan.items,
        rejectionReason: null,
      });
      const reply = catalogOrderReply({
        orderNumber: order.orderNumber,
        total: Number(order.totalAmount),
        currency: branch.restaurant.currency || 'INR',
        upiVpa: branch.restaurant.upiVpa,
      });
      try {
        await this.sendPayment(connection, inbound.from!, reply, {
          vpa: branch.restaurant.upiVpa,
          name: branch.restaurant.upiPayeeName || branch.restaurant.name,
          amount: Number(order.totalAmount),
          currency: branch.restaurant.currency || 'INR',
          orderNumber: order.orderNumber,
          orderId: order.id,
        });
      } catch {
        return 'Order saved. The WhatsApp reply did not send.';
      }
      return null;
    } catch (err) {
      if (err instanceof BadRequestException) {
        await this.reject(connection, inbound, exceptionText(err));
        return null;
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await this.prisma.order.findFirst({
          where: { branchId: connection.branchId, clientRequestId: requestId },
          select: { id: true },
        });
        if (again) {
          await this.saveSubmission(connection, inbound, {
            submissionStatus: 'ORDERED',
            orderId: again.id,
            customerId: customer.id,
            validatedCart: plan.items,
            rejectionReason: null,
          });
          return null;
        }
      }
      throw err;
    }
  }

  private async reject(
    connection: { restaurantId: string; branchId: string; phoneNumberId: string; accessTokenSealed: string | null },
    inbound: CatalogInbound,
    reason: string,
  ) {
    await this.saveSubmission(connection, inbound, {
      submissionStatus: 'REJECTED',
      orderId: null,
      customerId: null,
      validatedCart: null,
      rejectionReason: reason.slice(0, 300),
    });
    if (!inbound.from) return;
    await this.sendCloud(connection, inbound.from, whatsappTextPayload(inbound.from, reason.slice(0, 300))).catch(
      () => undefined,
    );
  }

  private async saveSubmission(
    connection: { restaurantId: string; branchId: string },
    inbound: CatalogInbound,
    data: {
      submissionStatus: string;
      orderId: string | null;
      customerId: string | null;
      validatedCart: unknown;
      rejectionReason: string | null;
    },
  ) {
    const shared = {
      restaurantId: connection.restaurantId,
      catalogId: inbound.catalogId,
      submittedCart: inbound.items as unknown as Prisma.InputJsonValue,
      validatedCart: data.validatedCart == null ? Prisma.JsonNull : (data.validatedCart as Prisma.InputJsonValue),
      orderId: data.orderId,
      customerId: data.customerId,
      submissionStatus: data.submissionStatus,
      rejectionReason: data.rejectionReason,
    };
    await this.prisma.whatsAppCatalogSubmission.upsert({
      where: { branchId_messageId: { branchId: connection.branchId, messageId: inbound.providerEventId } },
      create: { branchId: connection.branchId, messageId: inbound.providerEventId, ...shared },
      update: shared,
    });
  }

  private async customerFor(branchId: string, inbound: CatalogInbound) {
    const phone = inbound.from ?? '';
    const existing = await this.prisma.customer.findFirst({
      where: { branchId, phone },
      select: { id: true },
    });
    if (existing) return existing;
    return this.prisma.customer.create({
      data: { branchId, phone, name: inbound.name?.slice(0, 60) || null },
      select: { id: true },
    });
  }

  async sendPaidReceipt(orderId: string): Promise<boolean> {
    const submission = await this.prisma.whatsAppCatalogSubmission.findFirst({
      where: { orderId, submissionStatus: 'ORDERED', receiptSentAt: null },
    });
    if (!submission) return false;
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId: submission.branchId, status: 'PAID', source: 'WHATSAPP' },
      include: {
        items: true,
        payments: true,
        customer: { select: { name: true, phone: true } },
        branch: {
          select: {
            name: true,
            address: true,
            phone: true,
            gstNumber: true,
            restaurant: { select: { name: true, currency: true } },
          },
        },
      },
    });
    const phone = order?.customer?.phone?.trim();
    if (!order || !phone) return false;
    const connection = await this.prisma.whatsAppCatalogConnection.findUnique({
      where: { branchId: submission.branchId },
    });
    if (!connection || connection.connectionStatus !== 'CONNECTED' || !connection.accessTokenSealed) {
      return false;
    }
    const claimed = await this.prisma.whatsAppCatalogSubmission.updateMany({
      where: { id: submission.id, receiptSentAt: null },
      data: { receiptSentAt: new Date() },
    });
    if (claimed.count !== 1) return false;
    try {
      const pdf = await buildReceiptPdf({
        restaurantName: order.branch.restaurant.name,
        branchName: order.branch.name,
        address: order.branch.address,
        phone: order.branch.phone,
        gstNumber: order.branch.gstNumber,
        currency: order.branch.restaurant.currency || 'INR',
        orderNumber: order.orderNumber,
        createdAt: order.createdAt,
        guestName: order.guestName || order.customer?.name || null,
        items: order.items.map((item) => ({
          name: item.nameSnapshot,
          quantity: item.quantity,
          lineTotal: Number(item.lineTotal),
        })),
        subtotal: Number(order.subtotal),
        discountAmount: Number(order.discountAmount),
        taxAmount: Number(order.taxAmount),
        tipAmount: Number(order.tipAmount),
        totalAmount: Number(order.totalAmount),
        payments: order.payments.map((payment) => ({
          method: payment.method,
          amount: Number(payment.amount),
        })),
      });
      const filename = `receipt-${order.orderNumber}.pdf`;
      const mediaId = await this.uploadMedia(connection, pdf, 'application/pdf', filename);
      await this.sendCloud(
        connection,
        phone,
        whatsappDocumentPayload(phone, mediaId, filename, `Receipt ${order.orderNumber}`),
      );
      return true;
    } catch (err) {
      await this.prisma.whatsAppCatalogSubmission.update({
        where: { id: submission.id },
        data: { receiptSentAt: null },
      });
      throw err;
    }
  }

  private async sendDueReceipts() {
    const rows = await this.prisma.whatsAppCatalogSubmission.findMany({
      where: { submissionStatus: 'ORDERED', receiptSentAt: null, orderId: { not: null } },
      take: 10,
      select: { orderId: true },
    });
    for (const row of rows) {
      if (!row.orderId) continue;
      try {
        await this.sendPaidReceipt(row.orderId);
      } catch (err) {
        this.logger.warn(`Receipt skipped: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }

  private async sendPayment(
    connection: { phoneNumberId: string; accessTokenSealed: string | null },
    to: string,
    reply: string,
    upi: {
      vpa: string | null;
      name: string | null;
      amount: number;
      currency: string;
      orderNumber: string;
      orderId: string;
    },
  ) {
    const text = whatsappTextPayload(to, reply);
    if (!upi.vpa || upi.currency.toUpperCase() !== 'INR' || !(upi.amount > 0)) {
      await this.sendCloud(connection, to, text);
      return;
    }
    try {
      const uri = buildUpiUri({
        vpa: upi.vpa,
        name: upi.name,
        amount: upi.amount,
        note: `Order ${upi.orderNumber}`,
        ref: upi.orderId,
      });
      const png = await QRCode.toBuffer(uri, {
        type: 'png',
        errorCorrectionLevel: 'M',
        width: 512,
        margin: 2,
      });
      const mediaId = await this.uploadMedia(connection, png, 'image/png', 'upi-qr.png');
      await this.sendCloud(connection, to, whatsappImagePayload(to, mediaId, reply));
    } catch {
      await this.sendCloud(connection, to, text);
    }
  }

  private async uploadMedia(
    connection: { phoneNumberId: string; accessTokenSealed: string | null },
    bytes: Buffer,
    mime: string,
    filename: string,
  ) {
    if (!connection.accessTokenSealed) throw new Error('Paste the access token');
    const token = openSecret(connection.accessTokenSealed, this.keyMaterial());
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', mime);
    form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    const response = await fetch(whatsappMediaUrl(this.graphBase(), connection.phoneNumberId), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json().catch(() => null)) as { id?: string } | null;
    if (!response.ok || !json?.id) throw new Error(`WhatsApp returned ${response.status}`);
    return json.id;
  }

  private async sendCloud(
    connection: { phoneNumberId: string; accessTokenSealed: string | null },
    to: string,
    payload: object,
  ) {
    if (!connection.accessTokenSealed) throw new Error('Paste the access token');
    const token = openSecret(connection.accessTokenSealed, this.keyMaterial());
    const response = await fetch(whatsappMessagesUrl(this.graphBase(), connection.phoneNumberId), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`WhatsApp returned ${response.status}`);
  }

  private async noteConnection(parsed: { phoneNumberId: string | null; status: 'CONNECTED' | 'DISCONNECTED' | null }) {
    if (!parsed.phoneNumberId) return;
    const row = await this.prisma.whatsAppCatalogConnection.findUnique({
      where: { phoneNumberId: parsed.phoneNumberId },
    });
    if (!row) return;
    await this.prisma.whatsAppCatalogConnection.update({
      where: { id: row.id },
      data: {
        lastWebhookAt: new Date(),
        ...(parsed.status ? { connectionStatus: parsed.status } : {}),
        ...(parsed.status === 'DISCONNECTED' ? { accessTokenSealed: null } : {}),
      },
    });
  }

  private graphBase() {
    const root = (this.config.get<string>('META_GRAPH_BASE') ?? 'https://graph.facebook.com').replace(/\/$/, '');
    const version = this.config.get<string>('META_GRAPH_API_VERSION') ?? CATALOG_GRAPH_VERSION;
    return `${root}/${version}`;
  }

  private keyMaterial() {
    const key = this.config.get<string>('WEBHOOK_KEY') ?? this.config.get<string>('JWT_SECRET') ?? '';
    if (key.length < 16) throw new Error('Set WEBHOOK_KEY or JWT_SECRET before sending WhatsApp');
    return key;
  }
}

function asInbound(payload: Prisma.JsonValue): CatalogInbound | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const row = payload as unknown as CatalogInbound;
  if (!row.providerEventId || !row.phoneNumberId || !row.eventType) return null;
  return row;
}

function exceptionText(err: BadRequestException): string {
  const body = err.getResponse();
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message: unknown }).message;
    return Array.isArray(message) ? message.join(', ') : String(message);
  }
  return err.message;
}
