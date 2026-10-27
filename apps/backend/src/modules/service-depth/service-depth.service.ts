import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sealSecret } from '../../auth/totp';
import { PrismaService } from '../../prisma/prisma.service';
import { CommerceService } from '../commerce/commerce.service';
import { MessagingService } from '../messaging/messaging.service';
import { OrdersService } from '../orders/orders.service';
import { ReservationsService } from '../reservations/reservations.service';
import { convertQuantity } from '../inventory/unit-convert';

@Injectable()
export class ServiceDepthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly orders: OrdersService,
    private readonly messaging: MessagingService,
    private readonly commerce: CommerceService,
    private readonly reservations: ReservationsService,
  ) {}

  async repeatLast(branchId: string, userId: string, customerId: string) {
    const last = await this.orders.lastPaidForCustomer(branchId, customerId);
    const created = await this.orders.createOrder(branchId, userId, {
      type: last.tableId ? 'DINE_IN' : 'TAKEAWAY',
      tableId: last.tableId ?? undefined,
      customerId,
      guestName: last.guestName ?? undefined,
      guestCount: last.guestCount && last.guestCount > 0 ? last.guestCount : undefined,
      notes: `Repeat of ${last.orderNumber}`,
      items: last.items.map((item) => ({
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        modifierIds: item.modifiers.map((modifier) => modifier.modifierId),
        kitchenNote: item.kitchenNote ?? undefined,
        guestNumber: item.guestNumber && item.guestNumber > 0 ? item.guestNumber : undefined,
        discountPercent: Number(item.discountPercent) || undefined,
        weightKg: item.weightKg ? Number(item.weightKg) : undefined,
      })),
    });
    return this.prisma.order.update({
      where: { id: created.id },
      data: { source: 'REPEAT', partyName: last.partyName },
    });
  }

  async sessions(branchId: string) {
    const orders = await this.prisma.order.findMany({
      where: { branchId, status: 'OPEN', type: 'DINE_IN', tableId: { not: null } },
      include: { table: { select: { id: true, number: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      partyName: order.partyName,
      guestCount: order.guestCount,
      totalAmount: Number(order.totalAmount),
      tableId: order.tableId,
      tableLabel: order.table ? order.table.name || order.table.number : null,
      createdAt: order.createdAt,
    }));
  }

  async nameParty(branchId: string, orderId: string, partyName: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, branchId, status: 'OPEN' } });
    if (!order) throw new NotFoundException('Open order not found');
    return this.prisma.order.update({
      where: { id: order.id },
      data: { partyName: partyName.trim() || null },
    });
  }

  listFloors(branchId: string) {
    return this.prisma.floor.findMany({
      where: { branchId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, seating: true, sortOrder: true },
    });
  }

  async setSeating(branchId: string, floorId: string, seating: string) {
    const name = seating.trim().toUpperCase();
    if (!['INDOOR', 'OUTDOOR', 'COVERED'].includes(name)) {
      throw new BadRequestException('Seating must be INDOOR, OUTDOOR, or COVERED');
    }
    const floor = await this.prisma.floor.findFirst({ where: { id: floorId, branchId } });
    if (!floor) throw new NotFoundException('Floor not found');
    return this.prisma.floor.update({ where: { id: floor.id }, data: { seating: name } });
  }

  async foodCost(branchId: string) {
    const restaurant = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { restaurant: { select: { targetFoodCostPercent: true } } },
    });
    const target = Number(restaurant?.restaurant.targetFoodCostPercent ?? 30);
    const [items, conversions] = await Promise.all([
      this.prisma.menuItem.findMany({
        where: { branchId, isActive: true },
        include: { recipeLines: { include: { ingredient: true } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.unitConversion.findMany({ where: { branchId } }),
    ]);
    const custom = conversions.map((row) => ({
      fromUnit: row.fromUnit,
      toUnit: row.toUnit,
      factor: Number(row.factor),
    }));
    return {
      targetPercent: target,
      items: items.map((item) => {
        const batchCost = item.recipeLines.reduce((sum, line) => {
          const unit = line.unit ?? line.ingredient.unit;
          const quantity =
            convertQuantity(Number(line.quantity), unit, line.ingredient.unit, custom) ??
            Number(line.quantity);
          return sum + quantity * Number(line.ingredient.costPerUnit);
        }, 0);
        const foodCost = round2(batchCost / Math.max(1, item.servings ?? 1));
        const price = Number(item.price);
        const percent = price > 0 ? round2((foodCost / price) * 100) : 0;
        const suggested = target > 0 ? round2(foodCost / (target / 100)) : price;
        return {
          id: item.id,
          name: item.name,
          price,
          foodCost,
          foodCostPercent: percent,
          suggestedPrice: suggested,
          hasRecipe: item.recipeLines.length > 0,
        };
      }),
    };
  }

  async applySuggested(branchId: string, menuItemId: string, note?: string) {
    const report = await this.foodCost(branchId);
    const row = report.items.find((item) => item.id === menuItemId);
    if (!row) throw new NotFoundException('Dish not found');
    if (!row.hasRecipe) throw new BadRequestException('This dish has no recipe');
    await this.prisma.menuItem.update({
      where: { id: menuItemId },
      data: { price: row.suggestedPrice },
    });
    return this.prisma.recipeRevision.create({
      data: {
        menuItemId,
        foodCost: row.foodCost,
        sellingPrice: row.suggestedPrice,
        note: note?.trim() || `Applied suggested price at ${report.targetPercent}% food cost`,
      },
    });
  }

  recipeHistory(branchId: string, menuItemId: string) {
    return this.prisma.recipeRevision.findMany({
      where: { menuItemId, menuItem: { branchId } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async setTarget(branchId: string, percent: number) {
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId }, select: { restaurantId: true } });
    if (!branch) throw new NotFoundException('Branch not found');
    if (percent <= 0 || percent > 100) throw new BadRequestException('Target food cost must be between 0 and 100');
    await this.prisma.restaurant.update({
      where: { id: branch.restaurantId },
      data: { targetFoodCostPercent: percent },
    });
    return { targetPercent: percent };
  }

  async floorReport(branchId: string, from: string, to: string) {
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T23:59:59.999Z`);
    const orders = await this.prisma.order.findMany({
      where: { branchId, status: 'PAID', billedAt: { gte: start, lte: end }, type: 'DINE_IN' },
      select: { guestCount: true, tableId: true, totalAmount: true, billedAt: true },
    });
    const covers = orders.reduce((sum, order) => sum + (order.guestCount ?? 0), 0);
    const tables = new Set(orders.map((order) => order.tableId).filter(Boolean));
    const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
    return {
      covers,
      turns: orders.length,
      tablesUsed: tables.size,
      turnoverPerTable: tables.size ? round2(orders.length / tables.size) : 0,
      coversPerDay: round2(covers / days),
      sales: round2(orders.reduce((sum, order) => sum + Number(order.totalAmount), 0)),
    };
  }

  async attention(branchId: string) {
    const since = new Date(Date.now() - 45 * 60_000);
    const [oldBills, delayed, lowStock, soon] = await Promise.all([
      this.prisma.order.findMany({
        where: { branchId, status: 'OPEN', createdAt: { lt: since } },
        select: { id: true, orderNumber: true, createdAt: true },
        take: 20,
      }),
      this.prisma.kotItem.findMany({
        where: { status: 'DELAYED', kot: { order: { branchId } } },
        select: { id: true, delayReason: true, kot: { select: { order: { select: { orderNumber: true } } } } },
        take: 20,
      }),
      this.prisma.ingredient.findMany({
        where: { branchId, isActive: true },
        select: { id: true, name: true, currentStock: true, reorderLevel: true },
      }),
      this.prisma.reservation.findMany({
        where: {
          branchId,
          status: { in: ['RESERVED', 'CONFIRMED'] },
          reservedAt: { gte: new Date(), lte: new Date(Date.now() + 2 * 60 * 60_000) },
        },
        select: { id: true, customerName: true, reservedAt: true, guestCount: true },
        take: 20,
      }),
    ]);
    return {
      oldOpenBills: oldBills,
      delayedItems: delayed.map((item) => ({
        id: item.id,
        orderNumber: item.kot.order.orderNumber,
        reason: item.delayReason,
      })),
      lowStock: lowStock
        .filter((item) => Number(item.reorderLevel) > 0 && Number(item.currentStock) <= Number(item.reorderLevel))
        .map((item) => ({ id: item.id, name: item.name, currentStock: Number(item.currentStock) })),
      upcomingReservations: soon,
    };
  }

  async openTill(branchId: string, userId: string, openingFloat: number) {
    const open = await this.prisma.tillSession.findFirst({ where: { branchId, closedAt: null } });
    if (open) throw new BadRequestException('A till is already open');
    return this.prisma.tillSession.create({
      data: { branchId, openedById: userId, openingFloat },
    });
  }

  async currentTill(branchId: string) {
    const open = await this.prisma.tillSession.findFirst({
      where: { branchId, closedAt: null },
      include: { openedBy: { select: { name: true } } },
    });
    if (!open) return null;
    const expected = await this.expectedCash(branchId, open.openedAt, Number(open.openingFloat));
    return { ...open, openingFloat: Number(open.openingFloat), expectedCash: expected };
  }

  async closeTill(branchId: string, userId: string, countedCash: number, note?: string) {
    const open = await this.prisma.tillSession.findFirst({ where: { branchId, closedAt: null } });
    if (!open) throw new BadRequestException('No till is open');
    const expected = await this.expectedCash(branchId, open.openedAt, Number(open.openingFloat));
    return this.prisma.tillSession.update({
      where: { id: open.id },
      data: {
        closedAt: new Date(),
        closedById: userId,
        countedCash,
        expectedCash: expected,
        note: note?.trim() || null,
      },
    });
  }

  async requestApproval(branchId: string, userId: string, dto: { kind: string; orderId?: string; note?: string }) {
    const kind = dto.kind.trim().toUpperCase();
    if (!['DISCOUNT', 'VOID', 'REFUND'].includes(kind)) {
      throw new BadRequestException('Kind must be DISCOUNT, VOID, or REFUND');
    }
    return this.prisma.approvalRequest.create({
      data: { branchId, requestedById: userId, kind, orderId: dto.orderId, note: dto.note },
    });
  }

  listApprovals(branchId: string) {
    return this.prisma.approvalRequest.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { requestedBy: { select: { name: true } }, decidedBy: { select: { name: true } } },
    });
  }

  async decideApproval(branchId: string, userId: string, id: string, approve: boolean) {
    const row = await this.prisma.approvalRequest.findFirst({ where: { id, branchId, status: 'PENDING' } });
    if (!row) throw new NotFoundException('Pending approval not found');
    return this.prisma.approvalRequest.update({
      where: { id: row.id },
      data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: userId, decidedAt: new Date() },
    });
  }

  async rules(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        restaurant: {
          select: { approvalDiscountAbove: true, approvalForVoid: true, approvalForRefund: true, noShowFee: true },
        },
      },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return {
      approvalDiscountAbove: branch.restaurant.approvalDiscountAbove == null ? null : Number(branch.restaurant.approvalDiscountAbove),
      approvalForVoid: branch.restaurant.approvalForVoid,
      approvalForRefund: branch.restaurant.approvalForRefund,
      noShowFee: Number(branch.restaurant.noShowFee),
    };
  }

  async saveRules(
    branchId: string,
    dto: { approvalDiscountAbove?: number | null; approvalForVoid: boolean; approvalForRefund: boolean; noShowFee: number },
  ) {
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId }, select: { restaurantId: true } });
    if (!branch) throw new NotFoundException('Branch not found');
    await this.prisma.restaurant.update({
      where: { id: branch.restaurantId },
      data: {
        approvalDiscountAbove: dto.approvalDiscountAbove == null ? null : dto.approvalDiscountAbove,
        approvalForVoid: dto.approvalForVoid,
        approvalForRefund: dto.approvalForRefund,
        noShowFee: dto.noShowFee,
      },
    });
    return this.rules(branchId);
  }

  async curbside(branchId: string) {
    const rows = await this.prisma.order.findMany({
      where: { branchId, curbside: true, status: { in: ['OPEN', 'BILLED', 'PAID'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      guestName: order.guestName,
      vehicleNote: order.vehicleNote,
      totalAmount: Number(order.totalAmount),
    }));
  }

  async markCurbside(branchId: string, orderId: string, vehicleNote: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, branchId } });
    if (!order) throw new NotFoundException('Order not found');
    return this.prisma.order.update({
      where: { id: order.id },
      data: { curbside: true, vehicleNote: vehicleNote.trim() || null, type: 'TAKEAWAY' },
    });
  }

  async noShow(branchId: string, userId: string, reservationId: string) {
    return this.reservations.settleNoShow(branchId, userId, reservationId);
  }

  async collectDeposit(branchId: string, userId: string, reservationId: string, reference?: string, method?: 'CASH' | 'CARD' | 'UPI' | 'WALLET' | 'HOUSE') {
    return this.reservations.collectDeposit(branchId, userId, reservationId, { reference, method });
  }

  async reservationText(branchId: string, reservationId: string) {
    const reservation = await this.prisma.reservation.findFirst({
      where: { id: reservationId, branchId },
      include: { branch: true },
    });
    if (!reservation) throw new NotFoundException('Reservation not found');
    if (!reservation.phone) throw new BadRequestException('This reservation has no phone number');
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: reservation.branch.restaurantId },
      select: { waCloudEnabled: true, smsEnabled: true },
    });
    const when = reservation.reservedAt.toLocaleString();
    const body = `Your table for ${reservation.guestCount} is booked for ${when}.`;
    const channels = [
      restaurant?.waCloudEnabled ? 'WHATSAPP' : null,
      restaurant?.smsEnabled ? 'SMS' : null,
    ].filter((channel): channel is 'WHATSAPP' | 'SMS' => channel != null);
    if (!channels.length) {
      throw new BadRequestException('Turn on WhatsApp Cloud or SMS in Operations before sending');
    }
    for (const channel of channels) {
      await this.messaging.dispatch({
        restaurantId: reservation.branch.restaurantId,
        branchId,
        channel,
        purpose: 'RESERVATION',
        to: reservation.phone,
        body,
      });
    }
    return { sent: channels.length, channels };
  }

  async whatsappSetup(branchId: string) {
    const row = await this.prisma.whatsAppIntake.findUnique({ where: { branchId } });
    return {
      enabled: row?.enabled ?? false,
      secretConfigured: Boolean(row),
      webhookPath: '/api/v1/public/whatsapp/orders',
    };
  }

  async enableWhatsapp(branchId: string) {
    const secret = randomBytes(24).toString('base64url');
    const data = {
      enabled: true,
      secretHash: hashSecret(secret),
      secretSealed: sealSecret(secret, this.key()),
    };
    const existing = await this.prisma.whatsAppIntake.findUnique({ where: { branchId } });
    if (existing) await this.prisma.whatsAppIntake.update({ where: { id: existing.id }, data });
    else await this.prisma.whatsAppIntake.create({ data: { branchId, ...data } });
    return { secret, webhookPath: '/api/v1/public/whatsapp/orders' };
  }

  async whatsappOrders(branchId: string) {
    const rows = await this.prisma.order.findMany({
      where: { branchId, source: 'WHATSAPP' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { items: { select: { nameSnapshot: true, quantity: true } } },
    });
    return rows.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      guestName: order.guestName,
      notes: order.notes,
      totalAmount: Number(order.totalAmount),
      items: order.items,
    }));
  }

  async intakeWhatsapp(secret: string, body: { text?: string; from?: string; guestName?: string }) {
    const row = await this.prisma.whatsAppIntake.findFirst({
      where: { secretHash: hashSecret(secret), enabled: true },
      include: { branch: true },
    });
    if (!row) throw new NotFoundException('WhatsApp intake secret did not match');
    const text = (body.text ?? '').trim();
    if (!text) throw new BadRequestException('Message text is required');
    const menu = await this.prisma.menuItem.findMany({
      where: { branchId: row.branchId, isActive: true },
      select: { id: true, name: true },
    });
    const items = menu
      .filter((item) => text.toLowerCase().includes(item.name.toLowerCase()))
      .map((item) => ({ menuItemId: item.id, quantity: 1, modifierIds: [] as string[] }));
    if (!items.length) throw new BadRequestException('No menu item name was found in the message');
    const actor = await this.prisma.user.findFirst({
      where: { restaurantId: row.branch.restaurantId, isActive: true },
      select: { id: true },
    });
    if (!actor) throw new BadRequestException('No staff user is available to own this order');
    if (row.branch.onlineOrdersPaused) {
      throw new BadRequestException('The kitchen has paused online orders');
    }
    const created = await this.orders.createOrder(
      row.branchId,
      actor.id,
      {
        type: 'TAKEAWAY',
        guestName: body.guestName?.trim() || body.from || 'WhatsApp',
        notes: text,
        items,
      },
      { channel: 'ONLINE', requireAcceptance: true },
    );
    const saved = await this.prisma.order.update({
      where: { id: created.id },
      data: { source: 'WHATSAPP' },
      select: { id: true, orderNumber: true },
    });
    const phone = body.from?.trim();
    if (phone) {
      await this.messaging
        .dispatch({
          restaurantId: row.branch.restaurantId,
          branchId: row.branchId,
          channel: 'WHATSAPP',
          purpose: 'RESERVATION',
          to: phone,
          body: `Order ${saved.orderNumber} is in. The counter will accept it before the kitchen starts.`,
        })
        .catch(() => undefined);
    }
    return saved;
  }

  async quoteGuestOrder(qrToken: string, orderNumber: string) {
    const order = await this.guestOrder(qrToken, orderNumber);
    const branch = await this.prisma.branch.findUnique({
      where: { id: order.branchId },
      include: { restaurant: true },
    });
    const preview =
      order.status === 'OPEN'
        ? await this.orders.previewBill(order.branchId, order.id, { tipAmount: Number(order.tipAmount) })
        : null;
    const gateway = branch
      ? await this.prisma.paymentGateway.findFirst({
          where: { restaurantId: branch.restaurantId, enabled: true, baseUrl: { not: null } },
          select: { id: true },
        })
      : null;
    return {
      orderNumber: order.orderNumber,
      status: order.status,
      totalAmount: Number(order.totalAmount),
      tipAmount: Number(order.tipAmount),
      due: preview?.totalDue ?? Number(order.totalAmount),
      currency: branch?.restaurant.currency ?? 'INR',
      demoMode: branch?.restaurant.demoMode ?? false,
      gatewayAvailable: Boolean(gateway),
      upi: branch?.restaurant.upiVpa
        ? { vpa: branch.restaurant.upiVpa, payeeName: branch.restaurant.upiPayeeName || branch.restaurant.name }
        : null,
      items: order.items.map((item) => ({
        id: item.id,
        name: item.nameSnapshot,
        quantity: item.quantity,
        guestNumber: item.guestNumber,
        lineTotal: Number(item.lineTotal),
      })),
    };
  }

  async guestPay(qrToken: string, orderNumber: string) {
    const order = await this.guestOrder(qrToken, orderNumber);
    if (order.status === 'PAID') return { paid: true };
    if (order.status !== 'OPEN') throw new BadRequestException('This order can no longer be paid');
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: order.branchId },
      include: { restaurant: true },
    });
    const preview = await this.orders.previewBill(order.branchId, order.id, {
      tipAmount: Number(order.tipAmount),
    });
    const due = preview.totalDue;
    if (!(due > 0)) throw new BadRequestException('Nothing is due on this order');
    if (branch.restaurant.demoMode) {
      await this.orders.checkout(order.branchId, order.id, order.createdById, {
        payments: [{ method: 'UPI', amount: due, reference: `DEMO${order.orderNumber}`.slice(0, 40) }],
        tipAmount: Number(order.tipAmount),
        requestId: `guest${order.id}`.slice(0, 64),
      });
      return { paid: true, due };
    }
    const gateway = await this.prisma.paymentGateway.findFirst({
      where: { restaurantId: branch.restaurantId, enabled: true, NOT: { baseUrl: null } },
    });
    if (gateway?.baseUrl) {
      const intent = await this.commerce.createIntent(
        order.branchId,
        branch.restaurantId,
        order.id,
        gateway.provider,
        due,
      );
      return { paid: false, due, checkoutUrl: intent.checkoutUrl };
    }
    if (!branch.restaurant.upiVpa) {
      throw new BadRequestException('Pay at the counter. No UPI id and no gateway is stored');
    }
    return { paid: false, due };
  }

  async guestTip(qrToken: string, orderNumber: string, tipAmount: number) {
    const order = await this.guestOrder(qrToken, orderNumber);
    return this.prisma.order.update({
      where: { id: order.id },
      data: { tipAmount: Math.max(0, tipAmount) },
      select: { orderNumber: true, tipAmount: true, totalAmount: true },
    });
  }

  async guestSplit(qrToken: string, orderNumber: string, itemId: string, guestNumber: number) {
    const order = await this.guestOrder(qrToken, orderNumber);
    const line = order.items.find((item) => item.id === itemId);
    if (!line) throw new NotFoundException('Line not found');
    await this.prisma.orderItem.update({ where: { id: line.id }, data: { guestNumber } });
    return { ok: true };
  }

  listRates(restaurantId: string) {
    return this.prisma.exchangeRate.findMany({ where: { restaurantId }, orderBy: { currency: 'asc' } });
  }

  saveRate(restaurantId: string, currency: string, rateToBase: number) {
    const code = currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new BadRequestException('Currency must be a 3-letter code');
    if (rateToBase <= 0) throw new BadRequestException('Rate must be greater than zero');
    return this.prisma.exchangeRate.upsert({
      where: { restaurantId_currency: { restaurantId, currency: code } },
      create: { restaurantId, currency: code, rateToBase },
      update: { rateToBase },
    });
  }

  listBrands(restaurantId: string) {
    return this.prisma.brand.findMany({
      where: { restaurantId },
      include: { branches: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
  }

  createBrand(restaurantId: string, name: string) {
    return this.prisma.brand.create({ data: { restaurantId, name: name.trim() } });
  }

  async assignBrand(restaurantId: string, branchId: string, brandId: string | null) {
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, restaurantId } });
    if (!branch) throw new NotFoundException('Branch not found');
    return this.prisma.branch.update({ where: { id: branch.id }, data: { brandId } });
  }

  listApps(restaurantId: string) {
    return this.prisma.installedApp.findMany({ where: { restaurantId }, orderBy: { name: 'asc' } }).then((rows) =>
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        baseUrl: row.baseUrl,
        secretConfigured: Boolean(row.secretSealed),
      })),
    );
  }

  async saveApp(
    restaurantId: string,
    dto: { id?: string; name: string; enabled: boolean; baseUrl?: string | null; secret?: string | null },
  ) {
    const data = {
      name: dto.name.trim(),
      enabled: dto.enabled,
      baseUrl: dto.baseUrl?.trim() || null,
      ...(dto.secret ? { secretSealed: sealSecret(dto.secret, this.key()) } : {}),
    };
    if (dto.id) {
      const existing = await this.prisma.installedApp.findFirst({ where: { id: dto.id, restaurantId } });
      if (!existing) throw new NotFoundException('App not found');
      return this.prisma.installedApp.update({ where: { id: existing.id }, data });
    }
    return this.prisma.installedApp.create({ data: { restaurantId, ...data } });
  }

  private async guestOrder(qrToken: string, orderNumber: string) {
    const table = await this.prisma.table.findFirst({
      where: { qrToken },
      include: { floor: true },
    });
    if (!table) throw new NotFoundException('Table QR is not recognized');
    const order = await this.prisma.order.findFirst({
      where: { branchId: table.floor.branchId, orderNumber, tableId: table.id },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found for this table');
    return order;
  }

  private async expectedCash(branchId: string, openedAt: Date, openingFloat: number) {
    const payments = await this.prisma.payment.findMany({
      where: { method: 'CASH', order: { branchId, billedAt: { gte: openedAt } } },
    });
    const refunds = await this.prisma.refund.findMany({
      where: { method: 'CASH', order: { branchId }, createdAt: { gte: openedAt } },
    });
    const inn = payments.reduce((sum, row) => sum + Number(row.amount), 0);
    const out = refunds.reduce((sum, row) => sum + Number(row.amount), 0);
    return round2(openingFloat + inn - out);
  }

  private key() {
    return this.config.get<string>('WEBHOOK_KEY') ?? this.config.get<string>('JWT_SECRET') ?? '';
  }
}

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function hashSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}
