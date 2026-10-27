import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import type { CartItemDto, GuestProfileDto } from '@nodedr-restaurant/types';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { MenuService } from '../menu/menu.service';
import { OrdersService } from '../orders/orders.service';
import { recommendDishes } from '../customers/recommend';

@Injectable()
export class PublicMenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly menu: MenuService,
  ) {}

  private async resolveTable(qrToken: string) {
    const table = await this.prisma.table.findUnique({
      where: { qrToken },
      include: {
        floor: { include: { branch: { include: { restaurant: true } } } },
      },
    });
    if (!table) throw new NotFoundException('This QR code is not recognized');
    return table;
  }

  async guestProfile(dto: GuestProfileDto) {
    const located = await this.locateToken(dto.token);
    if (!located) throw new NotFoundException('This link is not recognized');
    const { branch } = located;
    const phone = dto.phone.trim();
    let customer = await this.prisma.customer.findFirst({
      where: { branchId: branch.id, phone },
      include: { tier: true },
    });
    if (!customer) {
      let referredById: string | undefined;
      if (dto.referralCode) {
        const referrer = await this.prisma.customer.findFirst({
          where: { branchId: branch.id, referralCode: dto.referralCode.trim() },
        });
        if (!referrer) throw new BadRequestException('Referral code was not found');
        referredById = referrer.id;
      }
      customer = await this.prisma.customer.create({
        data: {
          branchId: branch.id,
          phone,
          name: dto.name?.trim() || null,
          birthday: dto.birthday ? new Date(`${dto.birthday}T00:00:00.000Z`) : null,
          referralCode: await this.uniqueReferralCode(),
          referredById,
        },
        include: { tier: true },
      });
    } else if (dto.name?.trim() && !customer.name) {
      customer = await this.prisma.customer.update({
        where: { id: customer.id },
        data: { name: dto.name.trim() },
        include: { tier: true },
      });
    }
    if (!customer.referralCode) {
      customer = await this.prisma.customer.update({
        where: { id: customer.id },
        data: { referralCode: await this.uniqueReferralCode() },
        include: { tier: true },
      });
    }
    const month = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: branch.restaurant.timezone,
        month: 'numeric',
      }).format(new Date()),
    );
    const year = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: branch.restaurant.timezone,
        year: 'numeric',
      }).format(new Date()),
    );
    const birthdayMonth =
      customer.birthday != null && customer.birthday.getUTCMonth() + 1 === month;
    return {
      restaurantName: branch.restaurant.name,
      branchName: branch.name,
      fssaiNumber: branch.restaurant.fssaiNumber,
      name: customer.name,
      phone: customer.phone,
      points: customer.loyaltyPoints,
      walletBalance: Number(customer.walletBalance),
      tier: customer.tier
        ? {
            name: customer.tier.name,
            earnMultiplier: Number(customer.tier.earnMultiplier),
          }
        : null,
      referralCode: customer.referralCode,
      birthdayOffer:
        birthdayMonth &&
        Number(branch.restaurant.birthdayDiscountPercent) > 0 &&
        customer.birthdayOfferYear !== year
          ? Number(branch.restaurant.birthdayDiscountPercent)
          : 0,
    };
  }

  private async locateToken(token: string) {
    const table = await this.prisma.table.findUnique({
      where: { qrToken: token },
      include: {
        floor: { include: { branch: { include: { restaurant: true } } } },
      },
    });
    if (table) return { branch: table.floor.branch };
    const branch = await this.prisma.branch.findUnique({
      where: { kioskToken: token },
      include: { restaurant: true },
    });
    return branch ? { branch } : null;
  }

  private async uniqueReferralCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 8; attempt++) {
      let code = '';
      for (let i = 0; i < 8; i++) code += alphabet[randomInt(alphabet.length)];
      const existing = await this.prisma.customer.findUnique({
        where: { referralCode: code },
        select: { id: true },
      });
      if (!existing) return code;
    }
    throw new BadRequestException('Could not assign a referral code');
  }

  async getMenuByQrToken(qrToken: string) {
    const table = await this.resolveTable(qrToken);
    const branch = table.floor.branch;
    const restaurant = branch.restaurant;
    const categories = await this.guestCategories(branch.id, {
      orderType: 'QR_ORDER',
    });
    return {
      restaurantName: restaurant.name,
      branchName: branch.name,
      tableName: table.name ?? `Table ${table.number}`,
      logoUrl: restaurant.logoUrl ?? null,
      currency: restaurant.currency,
      taxMode: branch.taxMode,
      taxLabel: branch.taxLabel,
      upi: restaurant.upiVpa
        ? {
            vpa: restaurant.upiVpa,
            payeeName: restaurant.upiPayeeName || restaurant.name,
          }
        : null,
      onlineOrdersPaused: branch.onlineOrdersPaused,
      pay: {
        cash: restaurant.payCash,
        card: restaurant.payCard,
        upi: restaurant.payUpi,
        other: restaurant.payOther,
      },
      categories,
    };
  }

  async guestCategories(
    branchId: string,
    hint?: { orderType?: string | null; foodPlatform?: string | null },
  ) {
    return this.menu.filterPublicCategories(
      branchId,
      await this.menuCategoriesForBranch(branchId),
      hint,
    );
  }

  /** Customer-visible menu tree, shared by the table-QR page and the kiosk. */
  menuCategoriesForBranch(branchId: string) {
    return this.prisma.menuCategory.findMany({
      where: { branchId, isActive: true, showOnWebsite: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        items: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            description: true,
            imageUrl: true,
            price: true,
            taxRatePercent: true,
            isVeg: true,
            isVegan: true,
            isJain: true,
            isGlutenFree: true,
            spiceLevel: true,
            allergens: true,
            isSeasonal: true,
            seasonStart: true,
            seasonEnd: true,
            availableFrom: true,
            availableTo: true,
            sizes: {
              orderBy: { sortOrder: 'asc' },
              select: { id: true, name: true, price: true },
            },
            modifierGroups: {
              orderBy: { sortOrder: 'asc' },
              select: {
                modifierGroup: {
                  select: {
                    id: true,
                    name: true,
                    minSelect: true,
                    maxSelect: true,
                    isRequired: true,
                    modifiers: {
                      orderBy: { sortOrder: 'asc' },
                      select: {
                        id: true,
                        name: true,
                        imageUrl: true,
                        priceAdjustment: true,
                        isDefault: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  async createOrder(
    qrToken: string,
    items: CartItemDto[],
    guestName: string,
    requestId?: string,
  ) {
    const table = await this.resolveTable(qrToken);
    const branchId = table.floor.branchId;
    if (table.floor.branch.onlineOrdersPaused) {
      throw new BadRequestException('The kitchen has paused online orders');
    }
    if (requestId) {
      const replay = await this.ordersService.beginRequest(branchId, requestId, items);
      if (replay) return this.ordersService.getOrder(branchId, replay);
    }

    // A guest who already ordered once this visit and scans again to add
    // more (e.g. drinks now, food later) should land on the same tab, not
    // open a second order for the table — mirrors how staff add a round
    // from the POS for an occupied table.
    const openOrder = await this.prisma.order.findFirst({
      where: { branchId, tableId: table.id, status: 'OPEN' },
    });
    if (openOrder) {
      const added = await this.ordersService.addItems(branchId, openOrder.id, items, {
        enforceModifierLimits: true,
        websiteOnly: true,
      });
      if (requestId) await this.ordersService.finishRequest(branchId, requestId, openOrder.id, items);
      return added;
    }

    // A guest scanning a QR code has no staff account, but Order.createdById
    // is a required FK — attribute the order to whoever is on the floor for
    // this table (assigned waiter), falling back to any staff member linked
    // to the branch (every branch has at least its owner) so this never
    // fails for lack of a "system user" that doesn't otherwise exist.
    const createdById =
      table.assignedWaiterId ??
      (
        await this.prisma.userBranch.findFirst({
          where: { branchId },
          orderBy: { userId: 'asc' },
        })
      )?.userId;
    if (!createdById) {
      throw new NotFoundException(
        'This branch has no staff to receive the order',
      );
    }

    return this.ordersService.createOrder(
      branchId,
      createdById,
      {
        type: 'QR_ORDER',
        tableId: table.id,
        guestName,
        items,
      },
      { channel: 'ONLINE', clientRequestId: requestId },
    );
  }

  /** Dishes from this guest's last paid bill, plus dishes they tend to order together. */
  async reorder(qrToken: string, phone: string) {
    const table = await this.resolveTable(qrToken);
    const branchId = table.floor.branchId;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 6) return { customerName: null, dishes: [], suggestions: [] };
    const customer = await this.prisma.customer.findFirst({
      where: { branchId, phone: { contains: digits.slice(-10) } },
      select: { id: true, name: true },
    });
    if (!customer) return { customerName: null, dishes: [], suggestions: [] };
    const last = await this.prisma.order.findFirst({
      where: { branchId, customerId: customer.id, status: 'PAID' },
      orderBy: { billedAt: 'desc' },
      include: {
        items: { include: { modifiers: { select: { modifierId: true } } } },
      },
    });
    const history = await this.prisma.orderItem.findMany({
      where: { order: { customerId: customer.id, branchId, status: 'PAID' } },
      select: {
        orderId: true,
        quantity: true,
        menuItemId: true,
        nameSnapshot: true,
      },
      take: 200,
    });
    return {
      customerName: customer.name,
      dishes: (last?.items ?? []).map((item) => ({
        menuItemId: item.menuItemId,
        name: item.nameSnapshot,
        quantity: item.quantity,
        unitPrice: Number(item.unitPriceSnapshot),
        modifierIds: item.modifiers.map((modifier) => modifier.modifierId),
      })),
      suggestions: recommendDishes(
        history.map((line) => ({
          orderId: line.orderId,
          menuItemId: line.menuItemId,
          name: line.nameSnapshot,
          quantity: line.quantity,
        })),
      ),
    };
  }

  /** Live status of the table's current tab, for the guest's QR page. */
  async getStatus(qrToken: string) {
    const table = await this.resolveTable(qrToken);
    const order = await this.prisma.order.findFirst({
      where: { tableId: table.id, status: { in: ['OPEN', 'BILLED'] } },
      orderBy: { createdAt: 'desc' },
      select: {
        orderNumber: true,
        status: true,
        acceptance: true,
        totalAmount: true,
        items: {
          select: {
            id: true,
            nameSnapshot: true,
            quantity: true,
            status: true,
          },
        },
      },
    });
    const requests = await this.prisma.tableRequest.findMany({
      where: { tableId: table.id, resolvedAt: null },
      select: { type: true },
    });
    return { order, openRequests: requests.map((r) => r.type) };
  }

  /** "Call waiter" / "Bring the bill". One open request per type per table. */
  async createRequest(qrToken: string, type: 'WAITER' | 'BILL') {
    const table = await this.resolveTable(qrToken);
    const branchId = table.floor.branchId;
    const existing = await this.prisma.tableRequest.findFirst({
      where: { tableId: table.id, type, resolvedAt: null },
    });
    if (existing) return { ok: true, alreadyRequested: true };

    const request = await this.prisma.tableRequest.create({
      data: { branchId, tableId: table.id, type },
    });
    this.realtime.emitToBranch(branchId, 'table.request', { id: request.id });
    const tableName = table.name ?? `Table ${table.number}`;
    try {
      await this.notifications.notifyByPermission(branchId, 'tables.manage', {
        type: type === 'BILL' ? 'table.bill' : 'table.waiter',
        title:
          type === 'BILL'
            ? `${tableName} wants the bill`
            : `${tableName} needs a waiter`,
        body: 'Requested from the table QR code',
        entity: 'Table',
        entityId: table.id,
      });
    } catch {
      // Best-effort: the request row and live event already exist.
    }
    return { ok: true, alreadyRequested: false };
  }
}
