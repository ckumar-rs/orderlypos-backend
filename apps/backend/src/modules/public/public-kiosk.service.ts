import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { resolveTaxLabel, type KioskOrderDto } from '@nodedr-restaurant/types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeMsisdn } from '../messaging/messaging';
import { MessagingService } from '../messaging/messaging.service';
import { OrdersService } from '../orders/orders.service';
import { kioskReceiptText } from './kiosk-receipt';
import { PublicMenuService } from './public-menu.service';

const SERVICE_LABEL = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway' } as const;
const MAX_ORDER_ATTEMPTS = 3;

/**
 * Self-service kiosk, reached only through the branch's opaque kioskToken.
 * Deliberately narrow: it can read the customer-visible menu and create one
 * KIOSK order at a time — never read back an order, list orders or touch any
 * staff data. Prices, modifiers and tax are all recomputed by OrdersService
 * (the same code the POS uses); nothing the client sends is trusted for money.
 */
@Injectable()
export class PublicKioskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly publicMenu: PublicMenuService,
    private readonly messaging: MessagingService,
  ) {}

  private async resolveBranch(kioskToken: string) {
    // A short/garbage token can never match; avoids a pointless query.
    if (!/^[a-f0-9]{32}$/.test(kioskToken)) {
      throw new NotFoundException('This kiosk is not available');
    }
    const branch = await this.prisma.branch.findUnique({
      where: { kioskToken },
      include: { restaurant: true },
    });
    if (!branch || !branch.isActive) {
      throw new NotFoundException('This kiosk is not available');
    }
    return branch;
  }

  async getMenu(kioskToken: string) {
    const branch = await this.resolveBranch(kioskToken);
    const categories = await this.publicMenu.guestCategories(branch.id, {
      orderType: 'KIOSK',
    });
    return {
      restaurantName: branch.restaurant.name,
      branchName: branch.name,
      logoUrl: branch.restaurant.logoUrl ?? null,
      currency: branch.restaurant.currency,
      country: branch.country,
      taxMode: branch.taxMode,
      taxLabel: resolveTaxLabel(branch.taxRegime, branch.taxLabel),
      services: {
        dineIn: branch.kioskDineInEnabled,
        takeaway: branch.kioskTakeawayEnabled,
      },
      upi: branch.restaurant.upiVpa
        ? {
            vpa: branch.restaurant.upiVpa,
            payeeName:
              branch.restaurant.upiPayeeName || branch.restaurant.name,
            demo: false,
          }
        : null,
      pay: {
        cash: branch.restaurant.payCash,
        card: branch.restaurant.payCard,
        upi: branch.restaurant.payUpi,
        other: branch.restaurant.payOther,
      },
      demoMode: branch.restaurant.demoMode,
      onlineOrdersPaused: branch.onlineOrdersPaused,
      // Empty categories are not worth a button on a touchscreen.
      categories: categories.filter((c) => c.items.length > 0),
    };
  }

  async createOrder(kioskToken: string, dto: KioskOrderDto) {
    const branch = await this.resolveBranch(kioskToken);
    if (branch.onlineOrdersPaused) {
      throw new BadRequestException('The kitchen has paused online orders');
    }
    if (
      (dto.serviceType === 'DINE_IN' && !branch.kioskDineInEnabled) ||
      (dto.serviceType === 'TAKEAWAY' && !branch.kioskTakeawayEnabled)
    ) {
      throw new BadRequestException('That service option is not available');
    }

    const replay = await this.ordersService.beginRequest(
      branch.id,
      dto.requestId,
      dto.items.map((item) => ({
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        modifierIds: item.modifierIds,
      })),
    );
    if (replay) {
      const existing = await this.findByRequestId(branch.id, dto.requestId);
      if (existing) return this.present(existing, branch.restaurant.currency);
    }

    await this.assertAvailable(branch.id, dto.items);

    const createdById = await this.resolveActor(branch.id);

    for (let attempt = 1; ; attempt++) {
      try {
        const order = await this.ordersService.createOrder(
          branch.id,
          createdById,
          {
            type: 'KIOSK',
            notes: `Kiosk · ${SERVICE_LABEL[dto.serviceType]}`,
            items: dto.items.map((i) => ({
              menuItemId: i.menuItemId,
              quantity: i.quantity,
              modifierIds: i.modifierIds,
              ...(i.sizeId ? { sizeId: i.sizeId } : {}),
              ...(i.kitchenNote ? { kitchenNote: i.kitchenNote } : {}),
            })),
          },
          // ONLINE channel => category visibility + guest modifier limits
          // are enforced. No requireAcceptance: a kiosk order goes straight
          // to the KDS, payment is taken separately at the counter.
          { channel: 'ONLINE', clientRequestId: dto.requestId },
        );
        return this.present(order, branch.restaurant.currency);
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          // Either a concurrent duplicate submit (same requestId) ...
          const dup = await this.findByRequestId(branch.id, dto.requestId);
          if (dup) return this.present(dup, branch.restaurant.currency);
          // ... or two orders racing for the same daily order number.
          if (attempt < MAX_ORDER_ATTEMPTS) continue;
        }
        throw err;
      }
    }
  }

  /** Marks a kiosk order paid with a fake UPI reference. Demo mode only. */
  async demoPay(kioskToken: string, orderNumber: string) {
    const branch = await this.resolveBranch(kioskToken);
    if (!branch.restaurant.demoMode) {
      throw new BadRequestException(
        'Demo payment is off. Turn on Demo mode in Settings',
      );
    }
    const order = await this.prisma.order.findFirst({
      where: { branchId: branch.id, orderNumber, type: 'KIOSK' },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'PAID') {
      return { ...this.present(order, branch.restaurant.currency), paid: true };
    }
    if (order.status !== 'OPEN') {
      throw new BadRequestException('This order can no longer be paid');
    }
    const actorId = await this.resolveActor(branch.id);
    await this.ordersService.checkout(branch.id, order.id, actorId, {
      payments: [
        {
          method: 'UPI',
          amount: Number(order.totalAmount),
          reference: `DEMO${order.orderNumber.replace(/\D/g, '').slice(-8)}`,
        },
      ],
      requestId: `demo-${order.id}`.slice(0, 64),
    });
    const paid = await this.prisma.order.findFirstOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    return { ...this.present(paid, branch.restaurant.currency), paid: true };
  }

  /** Sends the kiosk receipt to the guest's WhatsApp. Paid and unpaid both say which they are. */
  async sendWhatsAppReceipt(
    kioskToken: string,
    input: { requestId?: string; phone?: string },
  ) {
    const branch = await this.resolveBranch(kioskToken);
    const requestId = (input.requestId ?? '').trim();
    if (requestId.length < 8 || requestId.length > 64) {
      throw new BadRequestException('This order cannot be matched');
    }
    const phone = normalizeMsisdn(
      input.phone ?? '',
      branch.restaurant.smsCountryPrefix ||
        (branch.country === 'IN' ? '91' : ''),
    );
    if (!phone || phone.length < 10 || phone.length > 15) {
      throw new BadRequestException(
        'Enter a mobile number with at least 10 digits',
      );
    }
    const order = await this.prisma.order.findFirst({
      where: { branchId: branch.id, clientRequestId: requestId, type: 'KIOSK' },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    const paid = order.status === 'PAID';
    const sent = await this.messaging.dispatch({
      restaurantId: branch.restaurantId,
      branchId: branch.id,
      channel: 'WHATSAPP',
      purpose: 'RECEIPT',
      to: phone,
      body: kioskReceiptText({
        restaurant: branch.restaurant.name,
        orderNumber: order.orderNumber,
        lines: order.items.map((item) => ({
          quantity: item.quantity,
          name: item.nameSnapshot,
          lineTotal: item.lineTotal.toString(),
        })),
        total: order.totalAmount.toString(),
        paid,
      }),
    });
    return { status: sent?.status ?? 'QUEUED', error: sent?.error ?? null };
  }

  private findByRequestId(branchId: string, clientRequestId: string) {
    return this.prisma.order.findFirst({
      where: { branchId, clientRequestId },
      include: { items: true },
    });
  }

  /** Items switched off (or removed) since the kiosk loaded its menu. */
  private async assertAvailable(
    branchId: string,
    items: KioskOrderDto['items'],
  ) {
    const ids = [...new Set(items.map((i) => i.menuItemId))];
    const found = await this.prisma.menuItem.findMany({
      where: { id: { in: ids }, branchId },
      select: {
        id: true,
        isActive: true,
        category: { select: { isActive: true } },
      },
    });
    const byId = new Map(found.map((m) => [m.id, m]));
    const unavailable = ids.filter((id) => {
      const m = byId.get(id);
      return !m || !m.isActive || !m.category.isActive;
    });
    if (unavailable.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        code: 'ITEM_UNAVAILABLE',
        message: 'Some items are no longer available',
        unavailableItemIds: unavailable,
      });
    }
  }

  // Order.createdById is a required FK and a kiosk has no staff login:
  // attribute to the first staff member linked to the branch, exactly as the
  // table-QR flow does when no waiter is assigned.
  private async resolveActor(branchId: string) {
    const link = await this.prisma.userBranch.findFirst({
      where: { branchId },
      orderBy: { userId: 'asc' },
    });
    if (!link) {
      throw new NotFoundException(
        'This branch has no staff to receive the order',
      );
    }
    return link.userId;
  }

  // Only what the confirmation/ticket needs: no ids, no staff, no payments.
  private present(
    order: {
      orderNumber: string;
      subtotal: Prisma.Decimal;
      taxAmount: Prisma.Decimal;
      totalAmount: Prisma.Decimal;
      createdAt: Date;
      notes: string | null;
      items: {
        nameSnapshot: string;
        quantity: number;
        lineTotal: Prisma.Decimal;
      }[];
    },
    currency: string,
  ) {
    return {
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      currency,
      items: order.items.map((i) => ({
        name: i.nameSnapshot,
        quantity: i.quantity,
        lineTotal: i.lineTotal.toString(),
      })),
      subtotal: order.subtotal.toString(),
      taxAmount: order.taxAmount.toString(),
      totalAmount: order.totalAmount.toString(),
      paid: false,
    };
  }
}
