import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  canTransitionKot,
  KOT_STARTED_STATUSES,
  type BillPreviewDto,
  type CartItemDto,
  type CheckoutDto,
  type CreateOrderDto,
  type ExchangeItemDto,
  type RefundDto,
  type SplitTableDto,
  type SessionUser,
  type UpdateOrderDto,
  type UpdateOrderItemDto,
} from '@nodedr-restaurant/types';
import { AuditService } from '../../audit/audit.service';
import { isSqlite, stringList } from '../../common/sqlite';
import { NotificationsService } from '../../notifications/notifications.service';
import { GiftCardsService } from '../gift-cards/gift-cards.service';
import { InventoryService } from '../inventory/inventory.service';
import { salePortionFactor, violatesPortionStep } from '../inventory/portion';
import { MarketingService } from '../marketing/marketing.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { resolveProfile } from './escpos/encoder';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import {
  computeOrderTotals,
  priceLine,
  round2,
  toEffectiveInclusiveUnitPrice,
} from './pricing';
import { basketFingerprint, type BasketLine } from './basket';
import {
  computeBill,
  discountPercentOf,
  manualDiscountEntry,
  settlePayments,
  type Bill,
} from './settlement';
import type { TaxMode } from '@nodedr-restaurant/types';
import { JournalService } from '../accounting/journal.service';
import { VerifactuService } from '../verifactu/verifactu.service';
import { MenuService } from '../menu/menu.service';
import { MessagingService } from '../messaging/messaging.service';
import { earnCashback, earnPoints, resolveEmployeePercent, spendForLoyalty } from '../customers/loyalty';
import { consumePointLots, dropExpiredPoints } from '../customers/loyalty-ledger';
import { rollupKotStatus } from '../kds/kot-rollup';

const KOT_FORWARD_STATUSES = [
  'ACCEPTED',
  'PREPARING',
  'READY',
  'SERVED',
] as const;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly giftCards: GiftCardsService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly marketing: MarketingService,
    private readonly webhooks: WebhooksService,
    private readonly verifactu: VerifactuService,
    private readonly menu: MenuService,
    private readonly messaging: MessagingService,
    private readonly journal: JournalService,
  ) {}

  async listOpen(branchId: string, tableId?: string) {
    return this.prisma.order.findMany({
      where: { branchId, status: 'OPEN', ...(tableId ? { tableId } : {}) },
      include: { table: true, items: true, customer: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOrder(branchId: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, branchId },
      include: {
        table: true,
        customer: true,
        items: { include: { modifiers: true, menuItem: true } },
        kots: { include: { items: true, station: true } },
        payments: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async printerProfile(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        printerPaperWidthMm: true,
        printerCodepage: true,
        printerColumns: true,
      },
    });
    return resolveProfile({
      paperWidthMm: branch?.printerPaperWidthMm,
      codepage: branch?.printerCodepage,
      columns: branch?.printerColumns,
    });
  }

  async getReceiptData(branchId: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, branchId },
      include: {
        table: true,
        customer: true,
        items: { include: { modifiers: true } },
        payments: true,
        branch: { include: { restaurant: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  // Customer-facing channels (website / QR / integration) must never accept
  // an item from a category the owner switched off under "Show on website" —
  // hiding it from the menu listing alone would still let someone order it
  // with a known item id.
  private async assertOrderableOnWebsite(
    branchId: string,
    menuItemIds: string[],
  ) {
    const hidden = await this.prisma.menuItem.findMany({
      where: {
        id: { in: menuItemIds },
        branchId,
        category: { showOnWebsite: false },
      },
      select: { name: true },
    });
    if (hidden.length > 0) {
      throw new BadRequestException(
        `${hidden.map((h) => `"${h.name}"`).join(', ')} is not available for online ordering`,
      );
    }
  }

  private async getBranchTaxMode(branchId: string): Promise<TaxMode> {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { taxMode: true },
    });
    // Falls back to INCLUSIVE (the schema default, and the only mode that
    // existed before multi-region tax) if the branch somehow can't be
    // found here — createOrder/addItems already 404 earlier when the
    // branch itself is invalid, so this is just belt-and-suspenders.
    return branch?.taxMode ?? 'INCLUSIVE';
  }

  async beginRequest(
    branchId: string,
    requestId: string,
    items: BasketLine[],
  ): Promise<string | null> {
    const fingerprint = basketFingerprint(items);
    const receipt = await this.prisma.replayReceipt.findUnique({
      where: { branchId_requestId: { branchId, requestId } },
    });
    if (receipt) {
      if (receipt.fingerprint === fingerprint) return receipt.orderId;
      await this.recordConflict(branchId, requestId, receipt.orderId, items);
      throw new ConflictException('This queued order conflicts with the order already saved');
    }
    const existing = await this.prisma.order.findFirst({
      where: { branchId, clientRequestId: requestId },
      include: { items: { include: { modifiers: true } } },
    });
    if (!existing) return null;
    const previous = basketFingerprint(
      existing.items.map((item) => ({
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        modifierIds: item.modifiers.map((modifier) => modifier.modifierId),
      })),
    );
    if (previous === fingerprint) {
      await this.finishRequest(branchId, requestId, existing.id, items);
      return existing.id;
    }
    await this.recordConflict(branchId, requestId, existing.id, items);
    throw new ConflictException('This queued order conflicts with the order already saved');
  }

  async finishRequest(
    branchId: string,
    requestId: string,
    orderId: string,
    items: BasketLine[],
  ) {
    await this.prisma.replayReceipt
      .create({
        data: {
          branchId,
          requestId,
          orderId,
          fingerprint: basketFingerprint(items),
        },
      })
      .catch(() => undefined);
  }

  private async recordConflict(
    branchId: string,
    requestId: string,
    orderId: string,
    items: BasketLine[],
  ) {
    await this.prisma.offlineConflict.create({
      data: {
        branchId,
        requestId,
        reason: 'Queued basket does not match the order already saved',
        payload: { orderId, items } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async createOrder(
    branchId: string,
    userId: string,
    dto: CreateOrderDto,
    options: {
      channel?: 'STAFF' | 'ONLINE';
      requireAcceptance?: boolean;
      clientRequestId?: string;
      // Platform riders deliver, so the branch's own pincode zones and
      // minimums must not reject the ticket.
      skipDeliveryZone?: boolean;
      foodPlatform?: 'ZOMATO' | 'SWIGGY';
      externalOrderId?: string;
    } = {},
  ) {
    const clientRequestId = options.clientRequestId ?? dto.clientRequestId;
    if (clientRequestId) {
      const replay = await this.beginRequest(branchId, clientRequestId, dto.items);
      if (replay) return this.getOrder(branchId, replay);
    }
    const channel = options.channel ?? 'STAFF';
    // Online orders wait for a staff member to accept them unless this
    // branch is set to auto-confirm (Settings > Online orders).
    let acceptance: 'NOT_REQUIRED' | 'PENDING' | 'ACCEPTED' = 'NOT_REQUIRED';
    if (options.requireAcceptance) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { autoConfirmOrders: true },
      });
      acceptance = branch?.autoConfirmOrders ? 'ACCEPTED' : 'PENDING';
    }
    const menuItemIds = [...new Set(dto.items.map((i) => i.menuItemId))];
    if (channel === 'ONLINE')
      await this.assertOrderableOnWebsite(branchId, menuItemIds);
    const menuItems = await this.prisma.menuItem.findMany({
      where: { id: { in: menuItemIds }, branchId },
      include: { sizes: true, channelPrices: true },
    });
    if (menuItems.length !== menuItemIds.length) {
      throw new BadRequestException(
        'One or more menu items are invalid for this branch',
      );
    }
    await this.menu.assertItemsOnLiveMenu(branchId, menuItemIds);
    const salesChannel = await this.menu.resolveSalesChannel(branchId, {
      channelId: dto.salesChannelId,
      orderType: dto.type,
      foodPlatform: options.foodPlatform,
    });
    const pricedItems = await this.menu.adjustPrices(branchId, menuItems);
    const menuItemById = new Map(
      pricedItems
        .map((item) => this.menu.applyChannelToItem(item, salesChannel))
        .map((item) => [item.id, item]),
    );
    const taxMode = await this.getBranchTaxMode(branchId);

    const modifierIds = [...new Set(dto.items.flatMap((i) => i.modifierIds))];
    const modifiers = await this.prisma.modifier.findMany({
      where: { id: { in: modifierIds } },
    });
    const modifierById = new Map(modifiers.map((m) => [m.id, m]));
    if (modifiers.length !== modifierIds.length) {
      throw new BadRequestException('One or more modifiers are invalid');
    }
    await this.validateModifierSelections(
      branchId,
      dto.items,
      channel === 'ONLINE',
    );

    // A client-supplied tableId/customerId that belongs to a different
    // branch/restaurant must never be trusted directly: without this check,
    // the order below would create a real FK link to another tenant's
    // table (and flip its status to OCCUPIED) or customer, and this
    // branch's own staff could then read that other tenant's table/customer
    // details back out via getOrder()/getReceiptData()'s `include`.
    if (dto.tableId) {
      const table = await this.prisma.table.findFirst({
        where: { id: dto.tableId, floor: { branchId } },
        select: { id: true },
      });
      if (!table) {
        throw new BadRequestException('Table is invalid for this branch');
      }
    }
    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, branchId },
        select: { id: true },
      });
      if (!customer) {
        throw new BadRequestException('Customer is invalid for this branch');
      }
    }

    const lineInputs = dto.items.map((cartItem) =>
      this.buildLine(
        cartItem,
        menuItemById,
        modifierById,
        taxMode,
        channel !== 'ONLINE',
      ),
    );
    const totals = computeOrderTotals(lineInputs.map((l) => l.priced));

    // Delivery: the pincode must fall in one of this branch's active zones
    // and the item total must clear the zone's minimum. The zone's fee/ETA
    // are snapshotted onto the order.
    let delivery: Pick<
      Prisma.OrderUncheckedCreateInput,
      | 'deliveryZoneId'
      | 'deliveryFee'
      | 'deliveryAddress'
      | 'deliveryPincode'
      | 'deliveryPhone'
      | 'deliveryStatus'
      | 'deliveryEtaAt'
    > | null = null;
    if (dto.type === 'DELIVERY' && options.skipDeliveryZone) {
      if (!dto.delivery?.address || !dto.delivery.phone) {
        throw new BadRequestException(
          'Delivery orders need an address and phone',
        );
      }
      delivery = {
        deliveryStatus: 'UNASSIGNED',
        deliveryAddress: dto.delivery.address,
        deliveryPincode: dto.delivery.pincode || null,
        deliveryPhone: dto.delivery.phone,
        deliveryFee: 0,
      };
    } else if (dto.type === 'DELIVERY') {
      // Zone rules only apply once a branch has defined zones. Until then
      // delivery orders behave as before (no fee, address may travel in the
      // notes), so existing website integrations keep working.
      const hasZones =
        (await this.prisma.deliveryZone.count({
          where: { branchId, isActive: true },
        })) > 0;
      if (hasZones && !dto.delivery) {
        throw new BadRequestException(
          'Delivery orders need an address, pincode and phone',
        );
      }
      delivery = {
        deliveryStatus: 'UNASSIGNED',
        deliveryAddress: dto.delivery?.address,
        deliveryPincode: dto.delivery?.pincode,
        deliveryPhone: dto.delivery?.phone,
      };
      if (hasZones && dto.delivery) {
        const zone = isSqlite()
          ? (
              await this.prisma.deliveryZone.findMany({
                where: { branchId, isActive: true },
              })
            ).find((row) => stringList(row.pincodes).includes(dto.delivery!.pincode))
          : await this.prisma.deliveryZone.findFirst({
              where: {
                branchId,
                isActive: true,
                pincodes: { has: dto.delivery.pincode },
              },
            });
        if (!zone) {
          throw new BadRequestException(
            'Sorry, we do not deliver to that pincode',
          );
        }
        if (totals.subtotal < Number(zone.minOrderAmount)) {
          throw new BadRequestException(
            `Minimum order for ${zone.name} is ₹${Number(zone.minOrderAmount)}`,
          );
        }
        delivery.deliveryZoneId = zone.id;
        delivery.deliveryFee = zone.fee;
        delivery.deliveryEtaAt = new Date(
          Date.now() + zone.etaMinutes * 60_000,
        );
      }
    }
    let scheduledFor: Date | undefined;
    if (dto.scheduledFor) {
      scheduledFor = new Date(dto.scheduledFor);
      if (scheduledFor.getTime() < Date.now() + 10 * 60_000) {
        throw new BadRequestException(
          'Scheduled time must be at least 10 minutes from now',
        );
      }
    }

    const orderNumber = await this.nextOrderNumber(branchId);

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          branchId,
          orderNumber,
          type: dto.type,
          channel,
          acceptance,
          tableId: dto.tableId,
          guestCount: dto.guestCount,
          customerId: dto.customerId,
          guestName: dto.guestName,
          notes: dto.notes,
          clientRequestId,
          foodPlatform: options.foodPlatform,
          externalOrderId: options.externalOrderId,
          salesChannelId: salesChannel?.id,
          createdById: userId,
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          discountAmount: 0,
          totalAmount: totals.subtotal,
          scheduledFor,
          heldAt: dto.held && channel === 'STAFF' ? new Date() : null,
          ...(delivery
            ? {
                deliveryZoneId: delivery.deliveryZoneId,
                deliveryFee: delivery.deliveryFee,
                deliveryAddress: delivery.deliveryAddress,
                deliveryPincode: delivery.deliveryPincode,
                deliveryPhone: delivery.deliveryPhone,
                deliveryStatus: delivery.deliveryStatus,
                deliveryEtaAt: delivery.deliveryEtaAt,
              }
            : {}),
          items: {
            create: lineInputs.map((line) => ({
              menuItem: { connect: { id: line.menuItem.id } },
              nameSnapshot: line.menuItem.name,
              unitPriceSnapshot: line.menuItem.price,
              taxRateSnapshot: line.menuItem.taxRatePercent,
              quantity: line.weightKg ? 1 : line.cartItem.quantity,
              weightKg: line.weightKg,
              lineTotal: line.priced.lineTotal,
              kitchenNote: line.cartItem.kitchenNote,
              guestNumber: line.guestNumber,
              complimentary: line.complimentary,
              discountPercent: line.discountPercent,
              hsnCode: line.hsnCode,
              sizeName: line.sizeName,
              portionFactor: line.portionFactor,
              modifiers: {
                create: line.selectedModifiers.map((m) => ({
                  modifier: { connect: { id: m.id } },
                  nameSnapshot: m.name,
                  priceAdjSnapshot: m.priceAdjustment,
                })),
              },
            })),
          },
        },
        include: { items: true },
      });

      if (dto.tableId) {
        await tx.table.update({
          where: { id: dto.tableId },
          data: { status: 'OCCUPIED', statusSince: new Date() },
        });
      }

      // A pending online order must not reach the kitchen until accepted
      // (acceptOrder() generates the tickets then).
      // A scheduled order also waits: releaseDueScheduledOrders() sends it to
      // the kitchen shortly before its time.
      if (
        acceptance !== 'PENDING' &&
        !this.isDeferred(scheduledFor) &&
        !created.heldAt
      ) {
        await this.generateKots(tx, created.id, branchId, created.items);
      }

      return created;
    });

    // `acceptance` rides along so a kitchen screen can sound the alert for an
    // order that is waiting on a yes/no (it has no ticket to announce yet).
    this.realtime.emitToBranch(branchId, 'order.created', {
      id: order.id,
      acceptance,
    });

    const full = await this.getOrder(branchId, order.id);

    // "New order" is targeted by permission, not a hardcoded role — any
    // custom role holding kds.manage (the same key that gates the KDS
    // screens themselves, see packages/types/src/permissions.ts) gets it,
    // so a renamed/custom kitchen role never silently stops receiving
    // orders. Best-effort: a notification failure must never fail order
    // creation, which has already committed by this point — log and move on.
    try {
      const who = full.guestName ?? full.customer?.name ?? undefined;
      if (acceptance === 'PENDING') {
        // Needs a decision: goes to anyone who can accept/cancel orders.
        await this.notifications.notifyByPermission(branchId, 'orders.accept', {
          type: 'order.pending',
          title: 'New online order — accept?',
          body: `Order ${full.orderNumber} (${full.type.replace('_', ' ')})${who ? ` — ${who}` : ''} · ₹${Number(full.totalAmount)}`,
          entity: 'Order',
          entityId: full.id,
        });
      } else {
        const platformLabel =
          options.foodPlatform === 'ZOMATO'
            ? 'Zomato'
            : options.foodPlatform === 'SWIGGY'
              ? 'Swiggy'
              : null;
        await this.notifications.notifyByPermission(branchId, 'kds.manage', {
          type: 'order.new',
          title: platformLabel
            ? `New ${platformLabel} order`
            : channel === 'ONLINE'
              ? 'New online order'
              : 'New order',
          body: full.table
            ? `Order ${full.orderNumber} — Table ${full.table.number}`
            : `Order ${full.orderNumber} (${platformLabel ?? full.type})${who ? ` — ${who}` : ''}`,
          entity: 'Order',
          entityId: full.id,
        });
      }
    } catch (err) {
      this.logger.warn(
        `Failed to send new-order notification for order ${full.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (clientRequestId) {
      await this.finishRequest(branchId, clientRequestId, full.id, dto.items);
    }

    void this.webhooks.emitForBranch(branchId, 'order.created', {
      orderId: full.id,
      orderNumber: full.orderNumber,
      type: full.type,
      channel: full.channel,
      total: Number(full.totalAmount),
      deliveryAddress: full.deliveryAddress,
      deliveryPhone: full.deliveryPhone,
      scheduledFor: full.scheduledFor,
    });

    return full;
  }

  async addItems(
    branchId: string,
    orderId: string,
    items: CartItemDto[],
    options: { enforceModifierLimits?: boolean; websiteOnly?: boolean } = {},
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      include: { items: true, payments: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    this.assertNoPayments(order);
    await this.validateModifierSelections(
      branchId,
      items,
      options.enforceModifierLimits ?? false,
    );
    if (order.status !== 'OPEN') {
      throw new BadRequestException('Order is not open — cannot add items');
    }

    const menuItemIds = [...new Set(items.map((i) => i.menuItemId))];
    if (options.websiteOnly)
      await this.assertOrderableOnWebsite(branchId, menuItemIds);
    const menuItems = await this.prisma.menuItem.findMany({
      where: { id: { in: menuItemIds }, branchId },
      include: { sizes: true, channelPrices: true },
    });
    if (menuItems.length !== menuItemIds.length) {
      throw new BadRequestException(
        'One or more menu items are invalid for this branch',
      );
    }
    await this.menu.assertItemsOnLiveMenu(branchId, menuItemIds);
    const salesChannel = await this.menu.resolveSalesChannel(branchId, {
      channelId: order.salesChannelId,
      orderType: order.type,
      foodPlatform: order.foodPlatform,
    });
    const pricedItems = await this.menu.adjustPrices(branchId, menuItems);
    const menuItemById = new Map(
      pricedItems
        .map((item) => this.menu.applyChannelToItem(item, salesChannel))
        .map((item) => [item.id, item]),
    );
    const taxMode = await this.getBranchTaxMode(branchId);

    const modifierIds = [...new Set(items.flatMap((i) => i.modifierIds))];
    const modifiers = await this.prisma.modifier.findMany({
      where: { id: { in: modifierIds } },
    });
    const modifierById = new Map(modifiers.map((m) => [m.id, m]));
    if (modifiers.length !== modifierIds.length) {
      throw new BadRequestException('One or more modifiers are invalid');
    }

    const lineInputs = items.map((cartItem) =>
      this.buildLine(
        cartItem,
        menuItemById,
        modifierById,
        taxMode,
        !options.websiteOnly && !options.enforceModifierLimits,
      ),
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const newItems = await Promise.all(
        lineInputs.map((line) =>
          tx.orderItem.create({
            data: {
              orderId,
              menuItemId: line.menuItem.id,
              nameSnapshot: line.menuItem.name,
              unitPriceSnapshot: line.menuItem.price,
              taxRateSnapshot: line.menuItem.taxRatePercent,
              quantity: line.weightKg ? 1 : line.cartItem.quantity,
              weightKg: line.weightKg,
              lineTotal: line.priced.lineTotal,
              kitchenNote: line.cartItem.kitchenNote,
              guestNumber: line.guestNumber,
              complimentary: line.complimentary,
              discountPercent: line.discountPercent,
              hsnCode: line.hsnCode,
              sizeName: line.sizeName,
              portionFactor: line.portionFactor,
              modifiers: {
                create: line.selectedModifiers.map((m) => ({
                  modifier: { connect: { id: m.id } },
                  nameSnapshot: m.name,
                  priceAdjSnapshot: m.priceAdjustment,
                })),
              },
            },
          }),
        ),
      );

      const allLines = [...order.items, ...newItems].map((item) =>
        priceLine({
          quantity: item.quantity,
          unitPriceInclusive: Number(item.lineTotal) / item.quantity,
          taxRatePercent: Number(item.taxRateSnapshot),
        }),
      );
      const totals = computeOrderTotals(allLines);

      const result = await tx.order.update({
        where: { id: orderId },
        data: {
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          totalAmount: totals.subtotal,
        },
      });

      if (!order.heldAt) {
        await this.generateKots(tx, orderId, branchId, newItems);
      }

      return result;
    });

    this.realtime.emitToBranch(branchId, 'order.updated', { id: orderId });
    return this.getOrder(branchId, updated.id);
  }

  // Realistic floor rule: once the kitchen has actually started cooking (or
  // finished) any ticket, the order can no longer be cancelled from the
  // floor — food already in progress must be voided/wasted through
  // inventory instead, not silently disappeared. Cancelling is only safe
  // while every KOT is still NEW/ACCEPTED (queued, not yet fired).
  // Dashboard Orders page. `tab` picks the lifecycle bucket; `channel`/`type`
  // are the Online/Offline and Takeaway/Delivery/Dine-in classifiers.
  async listForManagement(
    branchId: string,
    filters: {
      tab?: 'pending' | 'active' | 'history';
      channel?: 'STAFF' | 'ONLINE';
      type?: string;
    },
  ) {
    const tab = filters.tab ?? 'active';
    const statusWhere: Prisma.OrderWhereInput =
      tab === 'pending'
        ? { status: 'OPEN', acceptance: 'PENDING' }
        : tab === 'active'
          ? {
              status: { in: ['OPEN', 'BILLED'] },
              acceptance: { not: 'PENDING' },
            }
          : {
              OR: [
                { status: { in: ['PAID', 'CANCELLED'] } },
                { acceptance: 'REJECTED' },
              ],
              createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
            };
    return this.prisma.order.findMany({
      where: {
        branchId,
        ...statusWhere,
        ...(filters.channel ? { channel: filters.channel } : {}),
        ...(filters.type ? { type: filters.type as never } : {}),
      },
      include: { table: true, customer: true, items: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async acceptOrder(branchId: string, orderId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'OPEN' || order.acceptance !== 'PENDING') {
      throw new ConflictException(
        order.acceptance === 'ACCEPTED'
          ? 'This order was already accepted'
          : order.acceptance === 'REJECTED' || order.status === 'CANCELLED'
            ? 'This order was already declined or cancelled'
            : 'This order is not waiting for acceptance',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      // Compare-and-set: two staff tapping Accept at once (or a double tap)
      // must not both pass, or the kitchen would get the tickets twice.
      const flipped = await tx.order.updateMany({
        where: { id: orderId, status: 'OPEN', acceptance: 'PENDING' },
        data: {
          acceptance: 'ACCEPTED',
          acceptedAt: new Date(),
          acceptedById: userId,
        },
      });
      if (flipped.count === 0) {
        throw new ConflictException(
          'This order was just accepted or declined by someone else',
        );
      }
      if (!this.isDeferred(order.scheduledFor ?? undefined)) {
        await this.generateKots(tx, orderId, branchId, order.items);
      }
    });
    this.realtime.emitToBranch(branchId, 'order.updated', {
      id: orderId,
      acceptance: 'ACCEPTED',
    });
    this.realtime.emitToBranch(branchId, 'kot.updated', { orderId });
    await this.audit.record({
      userId,
      action: 'order.accepted',
      entity: 'Order',
      entityId: orderId,
      metadata: { orderNumber: order.orderNumber, type: order.type },
    });
    try {
      await this.notifications.notifyByPermission(branchId, 'kds.manage', {
        type: 'order.new',
        title: 'New online order',
        body: `Order ${order.orderNumber} (${order.type.replace('_', ' ')})`,
        entity: 'Order',
        entityId: orderId,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to notify kitchen of accepted order ${orderId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.getOrder(branchId, orderId);
  }

  // Declining an incoming order. The order is kept (acceptance REJECTED,
  // status CANCELLED, source ONLINE_DECLINED) with who declined it and why;
  // nothing is deleted.
  async rejectOrder(
    branchId: string,
    orderId: string,
    userId: string,
    reason: string,
  ) {
    return this.withdrawOrder(branchId, orderId, userId, {
      reason,
      source: 'ONLINE_DECLINED',
      declineIncoming: true,
    });
  }

  // Permanently removes finished (PAID / CANCELLED) orders. Admin-only twice
  // over — the orders.delete permission AND an OWNER/ADMINISTRATOR role — and
  // the caller must re-enter their own password. Each removed order leaves an
  // audit row carrying a snapshot so the sale can still be reconstructed.
  async deleteFinishedOrders(
    branchId: string,
    actor: SessionUser,
    orderIds: string[],
    password: string,
  ) {
    if (!['OWNER', 'ADMINISTRATOR'].includes(actor.roleName)) {
      throw new ForbiddenException('Only an admin can delete transactions');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { passwordHash: true },
    });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new ForbiddenException('Incorrect admin password');
    }

    const ids = [...new Set(orderIds)];
    const orders = await this.prisma.order.findMany({
      where: { id: { in: ids }, branchId },
      include: { items: true, payments: true },
    });
    if (orders.length !== ids.length) {
      throw new NotFoundException('Some selected transactions no longer exist');
    }
    const live = orders.filter(
      (o) => !['PAID', 'CANCELLED'].includes(o.status),
    );
    if (live.length > 0) {
      throw new BadRequestException(
        `Only finished transactions can be deleted — ${live
          .map((o) => `#${o.orderNumber}`)
          .join(', ')} still in progress`,
      );
    }

    const invoiced = await this.verifactu.ordersWithRecords(ids);
    if (invoiced.length > 0) {
      throw new BadRequestException(
        'Sales with a VERI*FACTU invoice cannot be deleted - the fiscal log must keep them. Refund the sale instead.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.auditLog.createMany({
        data: orders.map((o) => ({
          userId: actor.id,
          action: 'order.deleted',
          entity: 'Order',
          entityId: o.id,
          metadata: {
            orderNumber: o.orderNumber,
            status: o.status,
            type: o.type,
            totalAmount: o.totalAmount.toString(),
            createdAt: o.createdAt.toISOString(),
            items: o.items.map((i) => `${i.quantity}x ${i.nameSnapshot}`),
            payments: o.payments.map((p) => ({
              method: p.method,
              amount: p.amount.toString(),
            })),
          },
        })),
      });
      await tx.order.deleteMany({ where: { id: { in: ids }, branchId } });
    });
    this.realtime.emitToBranch(branchId, 'order.deleted', { orderIds: ids });
    return { deleted: ids.length };
  }

  // Frees a table only when nothing else is still open on it. Two bills can
  // share a table (a second round opened separately, a QR order), so "this
  // order is done" must not blank the table out from under the other one.
  private async releaseTableIfIdle(
    tx: Prisma.TransactionClient,
    tableId: string | null,
    exceptOrderId: string,
  ) {
    if (!tableId) return;
    const stillOpen = await tx.order.count({
      where: { tableId, status: 'OPEN', id: { not: exceptOrderId } },
    });
    if (stillOpen === 0) {
      await tx.table.update({
        where: { id: tableId },
        data: { status: 'AVAILABLE', statusSince: new Date() },
      });
    }
  }

  async printerTarget(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        printerConnection: true,
        printerHost: true,
        printerPort: true,
      },
    });
    return (
      branch ?? {
        printerConnection: 'USB',
        printerHost: null,
        printerPort: 9100,
      }
    );
  }

  // Cancels an unpaid order. Rules (unchanged): only OPEN orders, and not
  // once the kitchen has started cooking. An OPEN order has taken no payment
  // and no stock (stock leaves at checkout), so there is nothing to reverse;
  // paid orders go through refund() instead. The status flip is conditional on
  // OPEN, so a checkout racing this call can never end up both PAID and
  // CANCELLED.
  async cancelOrder(
    branchId: string,
    orderId: string,
    userId: string,
    reason?: string,
    options: { source?: 'STAFF' | 'CUSTOMER'; confirmStarted?: boolean } = {},
  ) {
    return this.withdrawOrder(branchId, orderId, userId, {
      reason,
      source: options.source ?? 'STAFF',
      confirmStarted: options.confirmStarted,
    });
  }

  // The one path that takes an order off the floor, whoever asked for it:
  // staff, the guest, the kitchen refusing the only ticket, or a declined
  // online order. The record always stays (status CANCELLED + source + reason
  // + who/when + audit row); money and stock are untouched because neither
  // has moved before payment.
  private async withdrawOrder(
    branchId: string,
    orderId: string,
    userId: string,
    options: {
      reason?: string;
      source: 'STAFF' | 'CUSTOMER' | 'KITCHEN_REJECTED' | 'ONLINE_DECLINED';
      confirmStarted?: boolean;
      declineIncoming?: boolean;
    },
  ) {
    const reason = options.reason?.trim() || undefined;
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      include: { kots: true, payments: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (options.declineIncoming) {
      if (order.status !== 'OPEN' || order.acceptance !== 'PENDING') {
        throw new ConflictException(
          'This order is not waiting for acceptance - it may already have been accepted or declined',
        );
      }
    } else if (order.status !== 'OPEN') {
      throw new BadRequestException(
        order.status === 'PAID'
          ? 'This bill is already paid - use Refund to reverse it'
          : 'Only an open order can be cancelled',
      );
    }
    if (order.payments.length > 0) {
      throw new BadRequestException(
        'This order already has a payment - refund it instead of cancelling',
      );
    }
    const statuses = order.kots.map((k) => k.status);
    if (statuses.includes('SERVED')) {
      throw new BadRequestException(
        'Part of this order was already served - remove the items that were not served instead of cancelling it',
      );
    }
    const alreadyStarted = statuses.some((st) =>
      (KOT_STARTED_STATUSES as readonly string[]).includes(st),
    );
    if (alreadyStarted && !options.confirmStarted) {
      throw new ConflictException({
        statusCode: 409,
        code: 'KITCHEN_STARTED',
        message:
          'The kitchen has already started this order. Confirm to cancel it anyway - the food in progress will be wasted.',
      });
    }
    const pastNew = statuses.some((st) => st !== 'NEW' && st !== 'CANCELLED');
    if (!reason && (pastNew || options.declineIncoming)) {
      throw new BadRequestException('A reason is required');
    }
    const gates = options.source === 'STAFF' ? await this.restaurantGates(branchId) : null;

    await this.prisma.$transaction(async (tx) => {
      if (gates?.approvalForVoid) {
        await this.consumeApproval(tx, branchId, orderId, 'VOID');
      }
      const flipped = await tx.order.updateMany({
        where: {
          id: orderId,
          status: 'OPEN',
          ...(options.declineIncoming ? { acceptance: 'PENDING' } : {}),
        },
        data: {
          status: 'CANCELLED',
          cancelReason: reason ?? null,
          cancelledAt: new Date(),
          cancelledById: userId,
          cancelSource: options.source,
          ...(options.declineIncoming ? { acceptance: 'REJECTED' } : {}),
        },
      });
      if (flipped.count === 0) {
        throw new ConflictException(
          'This order was just paid or changed - refresh and check it',
        );
      }
      await tx.kot.updateMany({
        where: {
          orderId,
          status: { notIn: ['SERVED', 'CANCELLED', 'REJECTED'] },
        },
        data: { status: 'CANCELLED' },
      });
      await tx.kotItem.updateMany({
        where: {
          kot: { orderId },
          status: { notIn: ['SERVED', 'CANCELLED'] },
        },
        data: { status: 'CANCELLED' },
      });
      await this.releaseTableIfIdle(tx, order.tableId, orderId);
    });

    this.emitOrderWithdrawn(branchId, orderId, order.tableId);

    await this.audit.record({
      userId,
      action: options.declineIncoming ? 'order.declined' : 'order.cancelled',
      entity: 'Order',
      entityId: orderId,
      metadata: {
        orderNumber: order.orderNumber,
        tableId: order.tableId,
        type: order.type,
        source: options.source,
        reason: reason ?? null,
        kitchenStarted: alreadyStarted,
        ticketStatuses: statuses,
        total: order.totalAmount.toString(),
      },
    });
    void this.webhooks.emitForBranch(branchId, 'order.cancelled', {
      orderId,
      orderNumber: order.orderNumber,
      type: order.type,
    });

    return this.getOrder(branchId, orderId);
  }

  private emitOrderWithdrawn(
    branchId: string,
    orderId: string,
    tableId: string | null,
  ) {
    this.realtime.emitToBranch(branchId, 'order.updated', {
      id: orderId,
      status: 'CANCELLED',
    });
    this.realtime.emitToBranch(branchId, 'kot.updated', { orderId });
    if (tableId) {
      this.realtime.emitToBranch(branchId, 'table.updated', { id: tableId });
    }
  }

  private async recomputeTotals(tx: Prisma.TransactionClient, orderId: string) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    const totals = computeOrderTotals(
      items.map((item) =>
        priceLine({
          quantity: item.quantity,
          unitPriceInclusive: Number(item.lineTotal) / item.quantity,
          taxRatePercent: Number(item.taxRateSnapshot),
        }),
      ),
    );
    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        totalAmount: totals.subtotal,
      },
    });
  }

  private async editableOrder(branchId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      include: { items: true, payments: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'OPEN') {
      throw new BadRequestException(
        order.status === 'PAID'
          ? 'This bill is paid and cannot be edited - use Refund to correct it'
          : 'Only an open bill can be edited',
      );
    }
    this.assertNoPayments(order);
    return order;
  }

  // Once a part-payment is on a bill its figures are fixed (see resolveBill),
  // so lines can no longer be added, changed or removed under it.
  private assertNoPayments(order: { payments: unknown[] }) {
    if (order.payments.length > 0) {
      throw new ConflictException(
        'A payment has already been taken on this bill - settle the balance, or refund, before changing the items',
      );
    }
  }

  // Header corrections on an open bill. Moving to another table keeps the
  // order (and its tickets) intact and fixes both tables' status together.
  async updateOrder(
    branchId: string,
    orderId: string,
    userId: string,
    dto: UpdateOrderDto,
  ) {
    const order = await this.editableOrder(branchId, orderId);

    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, branchId },
        select: { id: true },
      });
      if (!customer) throw new BadRequestException('Customer not found');
    }

    const moving = dto.tableId && dto.tableId !== order.tableId;
    if (moving) {
      if (order.type !== 'DINE_IN') {
        throw new BadRequestException('Only dine-in bills have a table');
      }
      const target = await this.prisma.table.findFirst({
        where: { id: dto.tableId, floor: { branchId } },
      });
      if (!target) throw new BadRequestException('Table not found');
      if (target.status === 'OUT_OF_SERVICE') {
        throw new BadRequestException('That table is out of service');
      }
      const occupant = await this.prisma.order.findFirst({
        where: { tableId: target.id, status: 'OPEN', id: { not: orderId } },
        select: { orderNumber: true },
      });
      if (occupant) {
        throw new ConflictException(
          `That table already has open bill #${occupant.orderNumber} - merge the bills instead`,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          ...(moving ? { tableId: dto.tableId } : {}),
          ...(dto.guestName !== undefined ? { guestName: dto.guestName } : {}),
          ...(dto.guestCount !== undefined
            ? { guestCount: dto.guestCount }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.customerId !== undefined
            ? { customerId: dto.customerId }
            : {}),
        },
      });
      if (moving) {
        await tx.table.update({
          where: { id: dto.tableId },
          data: { status: 'OCCUPIED', statusSince: new Date() },
        });
        await this.releaseTableIfIdle(tx, order.tableId, orderId);
      }
    });

    this.realtime.emitToBranch(branchId, 'order.updated', { id: orderId });
    this.realtime.emitToBranch(branchId, 'kot.updated', { orderId });
    if (moving) {
      for (const id of [order.tableId, dto.tableId]) {
        if (id) this.realtime.emitToBranch(branchId, 'table.updated', { id });
      }
    }
    await this.audit.record({
      userId,
      action: moving ? 'order.table_changed' : 'order.edited',
      entity: 'Order',
      entityId: orderId,
      metadata: {
        orderNumber: order.orderNumber,
        changes: dto as unknown as Prisma.InputJsonValue,
        fromTableId: order.tableId,
      },
    });
    return this.getOrder(branchId, orderId);
  }

  // The kitchen must not lose track of food it is already making, so a line
  // can only be lowered/removed while its ticket is still queued.
  private async assertLineNotStarted(
    tx: Prisma.TransactionClient,
    itemId: string,
  ) {
    const started = await tx.kotItem.findFirst({
      where: {
        orderItemId: itemId,
        OR: [
          { status: { in: ['PREPARING', 'READY', 'SERVED'] } },
          { kot: { status: { in: ['PREPARING', 'READY', 'SERVED'] } } },
        ],
      },
    });
    if (started) {
      throw new ConflictException(
        'The kitchen has already started this item - it can no longer be changed here',
      );
    }
  }

  async updateOrderItem(
    branchId: string,
    orderId: string,
    itemId: string,
    userId: string,
    dto: UpdateOrderItemDto,
  ) {
    const order = await this.editableOrder(branchId, orderId);
    const item = order.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('Item not found on this bill');
    if (dto.quantity > item.quantity) {
      throw new BadRequestException(
        'To order more, add the item again so the kitchen gets a new ticket',
      );
    }
    if (dto.quantity === item.quantity) return this.getOrder(branchId, orderId);

    await this.prisma.$transaction(async (tx) => {
      await this.assertLineNotStarted(tx, itemId);
      const unit = Number(item.lineTotal) / item.quantity;
      await tx.orderItem.update({
        where: { id: itemId },
        data: {
          quantity: dto.quantity,
          lineTotal: round2(unit * dto.quantity),
        },
      });
      await this.recomputeTotals(tx, orderId);
    });

    this.realtime.emitToBranch(branchId, 'order.updated', { id: orderId });
    this.realtime.emitToBranch(branchId, 'kot.updated', { orderId });
    await this.audit.record({
      userId,
      action: 'order.item_changed',
      entity: 'Order',
      entityId: orderId,
      metadata: {
        orderNumber: order.orderNumber,
        item: item.nameSnapshot,
        from: item.quantity,
        to: dto.quantity,
        reason: dto.reason ?? null,
      },
    });
    return this.getOrder(branchId, orderId);
  }

  async removeOrderItem(
    branchId: string,
    orderId: string,
    itemId: string,
    userId: string,
    reason: string,
  ) {
    const order = await this.editableOrder(branchId, orderId);
    const item = order.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('Item not found on this bill');
    if (order.items.length === 1) {
      throw new BadRequestException(
        'This is the only item - cancel the order instead',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.assertLineNotStarted(tx, itemId);
      await tx.orderItem.delete({ where: { id: itemId } });
      // A ticket left with nothing on it is cancelled, not left dangling.
      const empty = await tx.kot.findMany({
        where: { orderId, items: { none: {} }, status: { not: 'CANCELLED' } },
        select: { id: true },
      });
      if (empty.length > 0) {
        await tx.kot.updateMany({
          where: { id: { in: empty.map((k) => k.id) } },
          data: { status: 'CANCELLED' },
        });
      }
      await this.recomputeTotals(tx, orderId);
    });

    this.realtime.emitToBranch(branchId, 'order.updated', { id: orderId });
    this.realtime.emitToBranch(branchId, 'kot.updated', { orderId });
    await this.audit.record({
      userId,
      action: 'order.item_removed',
      entity: 'Order',
      entityId: orderId,
      metadata: {
        orderNumber: order.orderNumber,
        item: item.nameSnapshot,
        quantity: item.quantity,
        lineTotal: item.lineTotal.toString(),
        reason,
      },
    });
    return this.getOrder(branchId, orderId);
  }

  async previewDiscount(
    branchId: string,
    orderId: string,
    couponCode?: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId, status: 'OPEN' },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Open order not found');
    const subtotal = round2(
      order.items.reduce((sum, i) => sum + Number(i.lineTotal), 0),
    );
    const d = await this.marketing.resolveCheckoutDiscount(
      branchId,
      subtotal,
      couponCode,
      new Date(),
      {
        lines: order.items.map((item) => ({
          lineTotal: Number(item.lineTotal),
          quantity: item.quantity,
          menuItemId: item.menuItemId,
        })),
        customerId: order.customerId,
      },
    );
    return {
      amount: d.amount,
      couponCode: d.couponCode ?? null,
      promotionName: d.promotionName ?? null,
    };
  }

  // Everything that decides what a bill comes to, from the order as it stands
  // plus what the cashier entered. Once a payment has been taken the figures
  // are locked to what was stored then (a later round of payments must settle
  // the same bill), and further adjustments are refused rather than ignored.
  private async resolveBill(
    branchId: string,
    order: Prisma.OrderGetPayload<{
      include: { items: true; payments: true; customer: true };
    }>,
    adj: BillPreviewDto,
    customerId: string | null,
    staff?: { id: string; roleId: string } | null,
  ) {
    const paid = round2(
      order.payments.reduce((sum, p) => sum + Number(p.amount), 0),
    );
    const locked = order.payments.length > 0;
    const asked =
      (adj.discountPercent ?? 0) > 0 ||
      (adj.discountFlat ?? 0) > 0 ||
      (adj.tipAmount ?? 0) > 0 ||
      (adj.loyaltyPointsToRedeem ?? 0) > 0 ||
      !!adj.couponCode ||
      !!adj.employeeDiscount;

    if (locked) {
      if (asked) {
        throw new BadRequestException(
          'Discount, tip and loyalty points are locked once a payment has been taken on this bill',
        );
      }
      const bill: Bill = {
        subtotal: Number(order.subtotal),
        discountAmount: Number(order.discountAmount),
        discountPercent: discountPercentOf(
          Number(order.subtotal),
          Number(order.discountAmount),
        ),
        taxAmount: Number(order.taxAmount),
        loyaltyDiscountAmount: Number(order.loyaltyDiscountAmount),
        tipAmount: Number(order.tipAmount),
        deliveryFee: Number(order.deliveryFee),
        serviceChargeAmount: Number(order.serviceChargeAmount),
        totalDue: Number(order.totalAmount),
      };
      return {
        bill,
        locked,
        paid,
        auto: { amount: 0 } as {
          amount: number;
          couponId?: string;
          couponCode?: string | null;
          promotionName?: string | null;
        },
        pointsToRedeem: order.loyaltyPointsRedeemed,
        birthdayApplied: false,
        interstate: order.interstate,
      };
    }

    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: branchId },
      include: { restaurant: true },
    });
    const lines = order.items.map((item) =>
      priceLine({
        quantity: item.quantity,
        unitPriceInclusive: Number(item.lineTotal) / item.quantity,
        taxRatePercent: Number(item.taxRateSnapshot),
      }),
    );
    // Coupon / happy-hour discount, worked out on the bill's own subtotal and
    // added to any manual discount. A bad coupon code throws here, before
    // anything is charged.
    const foodTotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
    const rule = await this.prisma.loyaltyRule.findUnique({ where: { branchId } });
    let employeePercent = Number(branch.restaurant.employeeDiscountPercent);
    if (adj.employeeDiscount && staff) {
      const policies = await this.prisma.employeeDiscount.findMany({
        where: { branchId, isActive: true },
      });
      employeePercent = resolveEmployeePercent({
        policies: policies.map((policy) => ({
          userId: policy.userId,
          roleId: policy.roleId,
          percent: Number(policy.percent),
          maxAmount: policy.maxAmount == null ? null : Number(policy.maxAmount),
          isActive: policy.isActive,
        })),
        userId: staff.id,
        roleId: staff.roleId,
        fallbackPercent: employeePercent,
        subtotal: foodTotal,
      });
    }
    const auto = await this.marketing.resolveCheckoutDiscount(
      branchId,
      foodTotal,
      adj.couponCode,
      new Date(),
      {
        lines: order.items.map((item) => ({
          lineTotal: Number(item.lineTotal),
          quantity: item.quantity,
          menuItemId: item.menuItemId,
        })),
        employeeDiscount: adj.employeeDiscount,
        employeePercent,
        customerId: order.customerId ?? customerId,
      },
    );
    const profile =
      order.customer ??
      (customerId
        ? await this.prisma.customer.findFirst({
            where: { id: customerId, branchId },
          })
        : null);
    const birthday = this.birthdayOffer(branch.restaurant, profile);
    const birthdayApplied = birthday.birthdayApplied;
    const birthdayDiscount = birthdayApplied
      ? round2((foodTotal * birthday.percent) / 100)
      : 0;
    const guestState = profile?.gstStateCode?.trim().toUpperCase();
    const branchState = branch.gstStateCode?.trim().toUpperCase();
    const interstate = !!(
      guestState &&
      branchState &&
      guestState !== branchState
    );
    const pointsToRedeem = adj.loyaltyPointsToRedeem ?? 0;
    if (pointsToRedeem > 0 && !customerId) {
      throw new BadRequestException(
        'Cannot redeem loyalty points without a customer on the order',
      );
    }
    if (
      rule?.maxRedeemPerOrder != null &&
      pointsToRedeem > rule.maxRedeemPerOrder
    ) {
      throw new BadRequestException(
        `This branch allows at most ${rule.maxRedeemPerOrder} points on one bill`,
      );
    }
    const pointValue =
      rule?.pointValue != null
        ? Number(rule.pointValue)
        : Number(branch.restaurant.loyaltyPointValue);
    const bill = computeBill({
      lines,
      discountPercent: adj.discountPercent,
      discountFlat: adj.discountFlat,
      autoDiscount: round2(auto.amount + birthdayDiscount),
      loyaltyDiscountRequested: pointsToRedeem * pointValue,
      tip: adj.tipAmount,
      deliveryFee: Number(order.deliveryFee),
      serviceChargePercent: Number(branch.serviceChargePercent),
    });
    return {
      bill,
      locked,
      paid,
      auto,
      pointsToRedeem,
      birthdayApplied,
      interstate,
    };
  }

  // The figures a bill would settle at right now - what the Print Bill button
  // and the payment summary show. Read-only: nothing is saved, no status
  // changes, so it can be run any number of times.
  async previewBill(
    branchId: string,
    orderId: string,
    adj: BillPreviewDto,
    staff?: { id: string; roleId: string } | null,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      include: { items: true, payments: true, customer: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'CANCELLED') {
      throw new BadRequestException('This order was cancelled');
    }
    if (order.status === 'PAID') {
      const total = Number(order.totalAmount);
      return {
        locked: true,
        status: order.status,
        subtotal: Number(order.subtotal),
        discountAmount: Number(order.discountAmount),
        discountPercent: discountPercentOf(
          Number(order.subtotal),
          Number(order.discountAmount),
        ),
        discountType: order.discountType,
        discountValue: order.discountValue ? Number(order.discountValue) : null,
        couponCode: order.couponCode,
        promotionName: order.promotionName,
        taxAmount: Number(order.taxAmount),
        loyaltyPointsRedeemed: order.loyaltyPointsRedeemed,
        loyaltyDiscountAmount: Number(order.loyaltyDiscountAmount),
        tipAmount: Number(order.tipAmount),
        deliveryFee: Number(order.deliveryFee),
        serviceChargeAmount: Number(order.serviceChargeAmount),
        interstate: order.interstate,
        totalDue: total,
        amountPaid: total,
        balanceDue: 0,
      };
    }
    const customerId = order.customerId;
    const {
      bill,
      locked,
      paid,
      auto,
      pointsToRedeem,
      birthdayApplied,
      interstate,
    } = await this.resolveBill(branchId, order, adj, customerId, staff);
    const entry = locked
      ? order.discountType
        ? {
            type: order.discountType,
            value: Number(order.discountValue ?? 0),
          }
        : null
      : manualDiscountEntry(adj.discountPercent ?? 0, adj.discountFlat ?? 0);
    return {
      locked,
      status: order.status,
      ...bill,
      discountType: entry?.type ?? null,
      discountValue: entry?.value ?? null,
      couponCode: locked ? order.couponCode : (auto.couponCode ?? null),
      promotionName: locked
        ? order.promotionName
        : (auto.promotionName ?? (birthdayApplied ? 'Birthday offer' : null)),
      interstate,
      loyaltyPointsRedeemed:
        bill.loyaltyDiscountAmount > 0 ? pointsToRedeem : 0,
      amountPaid: paid,
      balanceDue: Math.max(round2(bill.totalDue - paid), 0),
    };
  }

  // Receipt data plus the numbers to print for it. A paid order prints what
  // was stored; an open one prints the bill as previewed, marked provisional,
  // so the paper always matches what Complete Payment will charge.
  async getBillForPrint(
    branchId: string,
    orderId: string,
    adj: BillPreviewDto,
    staff?: { id: string; roleId: string } | null,
  ) {
    const [order, view] = await Promise.all([
      this.getReceiptData(branchId, orderId),
      this.previewBill(branchId, orderId, adj, staff),
    ]);
    const open = order.status !== 'PAID';
    return {
      order,
      overrides: {
        subtotal: view.subtotal,
        discountAmount: view.discountAmount,
        discountPercent: view.discountPercent,
        taxAmount: view.taxAmount,
        tipAmount: view.tipAmount,
        loyaltyPointsRedeemed: view.loyaltyPointsRedeemed,
        loyaltyDiscountAmount: view.loyaltyDiscountAmount,
        totalAmount: view.totalDue,
        amountPaid: view.amountPaid,
        balanceDue: view.balanceDue,
        isProvisional: open,
      },
    };
  }

  async recordBillPrinted(branchId: string, orderId: string, userId: string) {
    await this.audit.record({
      userId,
      action: 'order.bill_printed',
      entity: 'Order',
      entityId: orderId,
      metadata: { branchId },
    });
  }

  async checkout(
    branchId: string,
    orderId: string,
    userId: string,
    dto: CheckoutDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      include: { items: true, customer: true, payments: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    // A retry of an attempt that already went through gets that result back.
    if (dto.requestId) {
      const replay = order.payments.some(
        (p) => p.clientRequestId === dto.requestId,
      );
      if (replay) return this.checkoutResult(branchId, orderId);
    }
    if (order.status !== 'OPEN') {
      throw new BadRequestException('Order is not open for checkout');
    }
    // Accepting is a separate decision from paying: an incoming order nobody
    // has accepted yet cannot be settled.
    if (order.acceptance === 'PENDING') {
      throw new ConflictException(
        'This order has not been accepted yet - accept it before taking payment',
      );
    }

    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: branchId },
      include: { restaurant: true },
    });
    const allowed: Record<string, boolean> = {
      CASH: branch.restaurant.payCash,
      CARD: branch.restaurant.payCard,
      UPI: branch.restaurant.payUpi,
      OTHER: branch.restaurant.payOther,
    };
    for (const payment of dto.payments) {
      if (payment.method in allowed && !allowed[payment.method]) {
        throw new BadRequestException(
          `${payment.method} is not enabled for this restaurant`,
        );
      }
    }
    const loyaltyEarnPerCurrency = branch.restaurant.loyaltyEarnPerCurrency;

    // A customer can be attached at billing time instead of when the order
    // was opened — walk-ins don't need a name up front, staff can add one
    // once the guest is ready to pay. Falls back to whatever was already on
    // the order (e.g. attached via QR order or set at cart time).
    let effectiveCustomerId = order.customerId;
    if (!effectiveCustomerId && dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, branchId },
      });
      if (!customer) throw new BadRequestException('Customer not found');
      effectiveCustomerId = customer.id;
    }

    const cashier = dto.employeeDiscount
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, roleId: true },
        })
      : null;
    const { bill, locked, paid, auto, pointsToRedeem, birthdayApplied, interstate } =
      await this.resolveBill(branchId, order, dto, effectiveCustomerId, cashier);
    const balance = round2(bill.totalDue - paid);
    const entry = manualDiscountEntry(
      dto.discountPercent ?? 0,
      dto.discountFlat ?? 0,
    );
    const discountGates = await this.restaurantGates(branchId);
    const needsDiscountApproval =
      discountGates?.approvalDiscountAbove != null &&
      (dto.discountPercent ?? 0) > Number(discountGates.approvalDiscountAbove);

    let stockSkipped: { menuItemId: string; name: string; reason: string }[] =
      [];
    let settlement!: ReturnType<typeof settlePayments>;
    try {
      await this.prisma.$transaction(async (tx) => {
        if (needsDiscountApproval) {
          await this.consumeApproval(tx, branchId, orderId, 'DISCOUNT');
        }
        let actualPointsRedeemed = order.loyaltyPointsRedeemed;
        let loyaltyDiscountAmount = Number(order.loyaltyDiscountAmount);

        if (!locked) {
          loyaltyDiscountAmount = 0;
          actualPointsRedeemed = 0;
          if (auto.couponId) {
            await this.marketing.redeemCoupon(tx, auto.couponId);
          }
          if (pointsToRedeem > 0 && effectiveCustomerId) {
            await dropExpiredPoints(tx, effectiveCustomerId);
            const customer = await tx.customer.findUniqueOrThrow({
              where: { id: effectiveCustomerId },
            });
            if (customer.loyaltyPoints < pointsToRedeem) {
              throw new BadRequestException(
                `Customer only has ${customer.loyaltyPoints} loyalty points available`,
              );
            }
            actualPointsRedeemed = pointsToRedeem;
            loyaltyDiscountAmount = bill.loyaltyDiscountAmount;
            // Guarded atomic decrement, not a read-then-write `set`: two
            // concurrent checkouts redeeming points for the same customer
            // could otherwise both read the same stale balance and one
            // redemption would be silently lost. The `loyaltyPoints: { gte }`
            // guard only lets the update through if the balance is still
            // sufficient at update time.
            const redeemResult = await tx.customer.updateMany({
              where: {
                id: effectiveCustomerId,
                loyaltyPoints: { gte: pointsToRedeem },
              },
              data: { loyaltyPoints: { decrement: pointsToRedeem } },
            });
            if (redeemResult.count === 0) {
              throw new BadRequestException(
                'Customer loyalty balance changed — please retry checkout',
              );
            }
            await consumePointLots(tx, effectiveCustomerId, pointsToRedeem);
          }
        }

        const manualTotal = round2(
          dto.payments.reduce((sum, p) => sum + p.amount, 0),
        );
        let giftCardApplied = 0;
        if (dto.giftCardCode) {
          const remainingAfterManual = round2(balance - manualTotal);
          if (remainingAfterManual > 0) {
            const result = await this.giftCards.debit(
              tx,
              branchId,
              dto.giftCardCode,
              remainingAfterManual,
            );
            giftCardApplied = result.amountApplied;
            await tx.giftCardRedemption.create({
              data: {
                giftCardId: result.giftCardId,
                orderId,
                amount: giftCardApplied,
              },
            });
          }
        }

        settlement = settlePayments({
          balance,
          payments: dto.payments,
          giftCardApplied,
          allowPartial: dto.allowPartial,
        });

        const paymentRows = settlement.payments.map((p, i) => ({
          method: p.method as never,
          amount: p.amount,
          tendered: p.tendered,
          changeGiven: p.changeGiven,
          reference: p.reference,
          createdById: userId,
          clientRequestId: i === 0 ? (dto.requestId ?? null) : null,
        }));
        if (giftCardApplied > 0) {
          paymentRows.push({
            method: 'GIFT_CARD' as never,
            amount: giftCardApplied,
            tendered: null,
            changeGiven: null,
            reference: dto.giftCardCode,
            createdById: userId,
            clientRequestId:
              paymentRows.length === 0 ? (dto.requestId ?? null) : null,
          });
        }

        // The bill's figures are fixed by the first payment, whether or not
        // it settles the bill.
        const lockedFigures = locked
          ? {}
          : {
              ...(effectiveCustomerId && !order.customerId
                ? { customerId: effectiveCustomerId }
                : {}),
              discountAmount: bill.discountAmount,
              discountType: entry?.type ?? null,
              discountValue: entry?.value ?? null,
              taxAmount: bill.taxAmount,
              couponCode: auto.couponCode ?? null,
              promotionName: auto.promotionName ?? null,
              loyaltyPointsRedeemed: actualPointsRedeemed,
              loyaltyDiscountAmount,
              tipAmount: bill.tipAmount,
              serviceChargeAmount: bill.serviceChargeAmount,
              interstate,
              totalAmount: bill.totalDue,
            };

        if (!settlement.fullyPaid) {
          await tx.order.update({
            where: { id: orderId, status: 'OPEN' },
            data: { ...lockedFigures, payments: { create: paymentRows } },
          });
          return;
        }

        // Stock moves exactly once, in this same transaction as the
        // OPEN->PAID update below (a losing concurrent checkout rolls its
        // deduction back). Shortages never block the sale; unmapped tracked
        // items are reported after commit instead of being skipped silently.
        const deduction = await this.inventory.deductForOrder(
          tx,
          branchId,
          userId,
          orderId,
          order.items.map((item) => ({
            menuItemId: item.menuItemId,
            quantity:
              (item.weightKg != null ? Number(item.weightKg) : item.quantity) *
              Number(item.portionFactor ?? 1),
          })),
        );
        stockSkipped = deduction.skipped;

        await this.releaseTableIfIdle(tx, order.tableId, orderId);

        // Loyalty earn on net spend (excluding tip), only once the sale is
        // actually paid — an atomic increment (race-free by construction, no
        // read-then-write window) rather than a computed `set`.
        if (effectiveCustomerId) {
          await this.awardLoyalty(tx, {
            customerId: effectiveCustomerId,
            restaurantId: branch.restaurantId,
            branchId,
            timezone: branch.restaurant.timezone,
            referralPoints: branch.restaurant.referralPoints,
            earnPerCurrency: loyaltyEarnPerCurrency,
            netSpend: round2(
              bill.subtotal - bill.discountAmount - loyaltyDiscountAmount,
            ),
            lines: order.items.map((item) => ({
              menuItemId: item.menuItemId,
              lineTotal: Number(item.lineTotal),
            })),
            birthdayApplied,
          });
        }

        // `status: 'OPEN'` in the where clause is the actual concurrency
        // guard: the initial status check above ran outside this
        // transaction, so two simultaneous checkout requests for the same
        // order could otherwise both pass it and both reach here, producing
        // two payment rows, a double inventory deduction and double loyalty
        // points. This update only succeeds if the row is still OPEN at
        // commit time; Prisma throws P2025 (caught below) for the loser, and
        // the whole transaction — including the gift card debit and loyalty
        // changes already applied above — rolls back with it.
        await tx.order.update({
          where: { id: orderId, status: 'OPEN' },
          data: {
            ...lockedFigures,
            status: 'PAID',
            billedAt: new Date(),
            payments: { create: paymentRows },
          },
        });
        // Spain VERI*FACTU: the sale's fiscal record is written in this same transaction, so a sale
        // is never paid without it (and a failure to produce it rolls the payment back).
        await this.verifactu.recordPaidOrder(tx, orderId);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2025') {
          throw new ConflictException(
            'This order was already checked out by another request.',
          );
        }
        // Same requestId arrived twice at once: the second is a replay.
        if (err.code === 'P2002' && dto.requestId) {
          return this.checkoutResult(branchId, orderId);
        }
      }
      throw err;
    }

    const updated = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { payments: true, table: true },
    });

    if (stockSkipped.length > 0) {
      this.logger.warn(
        `Order ${updated.orderNumber}: no stock deducted for ${stockSkipped
          .map((s) => `${s.name} (${s.reason})`)
          .join(', ')}`,
      );
      await this.audit.record({
        userId,
        action: 'inventory.deduction_skipped',
        entity: 'Order',
        entityId: orderId,
        metadata: { orderNumber: updated.orderNumber, items: stockSkipped },
      });
    }

    if (settlement.fullyPaid) {
      try {
        const added = await this.inventory.suggestReorders(branchId, userId);
        if (added > 0) {
          this.logger.log(
            `Order ${updated.orderNumber}: added ${added} low-stock ingredient(s) to the automatic reorder`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Order ${updated.orderNumber}: automatic reorder was not saved: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await this.audit.record({
      userId,
      action: settlement.fullyPaid
        ? 'order.paid'
        : 'order.partial_payment_recorded',
      entity: 'Order',
      entityId: orderId,
      metadata: {
        orderNumber: updated.orderNumber,
        amountDue: bill.totalDue,
        paidNow: settlement.paidNow,
        balanceAfter: settlement.balanceAfter,
        changeDue: settlement.changeDue,
        methods: settlement.payments.map((p) => `${p.method}:${p.amount}`),
      },
    });

    this.realtime.emitToBranch(branchId, 'order.updated', {
      id: updated.id,
      ...(settlement.fullyPaid
        ? { status: 'PAID' }
        : { balanceDue: settlement.balanceAfter }),
    });
    if (settlement.fullyPaid) {
      if (order.tableId) {
        this.realtime.emitToBranch(branchId, 'table.updated', {
          id: order.tableId,
        });
      }
      void this.journal
        .tryPostSale(branchId, userId, {
          id: updated.id,
          orderNumber: updated.orderNumber,
          billedAt: updated.billedAt,
          payments: updated.payments.map((payment) => ({
            method: payment.method,
            amount: payment.amount,
          })),
        })
        .catch((err) =>
          this.logger.warn(
            `Order ${updated.orderNumber}: journal was not posted: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      void this.webhooks.emitForBranch(branchId, 'order.paid', {
        orderId: updated.id,
        orderNumber: updated.orderNumber,
        type: updated.type,
        total: Number(updated.totalAmount),
        tip: Number(updated.tipAmount),
        discount: Number(updated.discountAmount),
        couponCode: updated.couponCode,
        payments: updated.payments.map((p) => ({
          method: p.method,
          amount: Number(p.amount),
        })),
      });
    }
    return {
      ...updated,
      settlement: {
        amountDue: bill.totalDue,
        amountPaid: round2(paid + settlement.paidNow),
        balanceDue: settlement.balanceAfter,
        changeDue: settlement.changeDue,
        fullyPaid: settlement.fullyPaid,
      },
    };
  }

  // Current settlement state of an order, for answering a replayed request.
  private async checkoutResult(branchId: string, orderId: string) {
    const updated = await this.prisma.order.findFirstOrThrow({
      where: { id: orderId, branchId },
      include: { payments: true, table: true },
    });
    const amountPaid = round2(
      updated.payments.reduce((sum, p) => sum + Number(p.amount), 0),
    );
    const total = Number(updated.totalAmount);
    return {
      ...updated,
      settlement: {
        amountDue: total,
        amountPaid,
        balanceDue:
          updated.status === 'PAID'
            ? 0
            : Math.max(round2(total - amountPaid), 0),
        changeDue: round2(
          updated.payments.reduce(
            (sum, p) => sum + Number(p.changeGiven ?? 0),
            0,
          ),
        ),
        fullyPaid: updated.status === 'PAID',
      },
    };
  }

  async refund(
    branchId: string,
    orderId: string,
    userId: string,
    dto: RefundDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'PAID') {
      throw new BadRequestException('Only a paid order can be refunded');
    }
    const refundGates = await this.restaurantGates(branchId);

    const refund = await this.prisma.$transaction(async (tx) => {
      if (refundGates?.approvalForRefund) {
        await this.consumeApproval(tx, branchId, orderId, 'REFUND');
      }
      // Row lock: bumping the order row here (rather than only reading it)
      // holds a Postgres row lock for the rest of this transaction, so a
      // second concurrent refund request on the same order blocks here
      // until the first commits — then its own re-read of `refunds` below
      // sees the first refund and correctly recomputes what's still
      // refundable. Without this, two simultaneous refund requests could
      // both read the same pre-refund `refundable` amount and together
      // refund more than the order was ever paid for.
      await tx.order.update({
        where: { id: orderId },
        data: { updatedAt: new Date() },
      });
      const refunds = await tx.refund.findMany({ where: { orderId } });
      const alreadyRefunded = round2(
        refunds.reduce((sum, r) => sum + Number(r.amount), 0),
      );
      const refundable = round2(Number(order.totalAmount) - alreadyRefunded);
      if (dto.amount > refundable) {
        throw new BadRequestException(
          `Cannot refund ${dto.amount} — only ${refundable} remains refundable on this order`,
        );
      }

      const created = await tx.refund.create({
        data: {
          orderId,
          amount: dto.amount,
          reason: dto.reason,
          method: dto.method,
          createdById: userId,
        },
      });
      await this.verifactu.recordRefund(tx, orderId, created.id, dto.amount);

      // Money-only refunds never touch stock. Stock comes back only for the
      // units the staff member says were physically returned, capped at what
      // was sold minus what earlier refunds already returned, as compensating
      // REVERSAL movements (the original consumption rows stay untouched).
      if (dto.returnedItems?.length) {
        const items = await tx.orderItem.findMany({
          where: { orderId },
          include: { stockReturns: true },
        });
        const byId = new Map(items.map((i) => [i.id, i]));
        const lines: { menuItemId: string; quantity: number }[] = [];
        for (const ret of dto.returnedItems) {
          const item = byId.get(ret.orderItemId);
          if (!item) {
            throw new BadRequestException(
              'Returned item does not belong to this order',
            );
          }
          const alreadyReturned = item.stockReturns.reduce(
            (sum, r) => sum + r.quantity,
            0,
          );
          if (ret.quantity > item.quantity - alreadyReturned) {
            throw new BadRequestException(
              `Cannot return ${ret.quantity} x ${item.nameSnapshot} — only ${item.quantity - alreadyReturned} left to return`,
            );
          }
          await tx.orderItemStockReturn.create({
            data: {
              orderItemId: item.id,
              refundId: created.id,
              quantity: ret.quantity,
            },
          });
          item.stockReturns.push({ quantity: ret.quantity } as never);
          lines.push({
            menuItemId: item.menuItemId,
            quantity: ret.quantity * Number(item.portionFactor ?? 1),
          });
        }
        await this.inventory.restoreForReturn(
          tx,
          branchId,
          userId,
          orderId,
          lines,
        );
      }

      if (dto.method === 'STORE_CREDIT' && order.customerId) {
        // Atomic increment, not read-then-write: two concurrent
        // STORE_CREDIT refunds for the same customer (from different
        // orders) could otherwise both read the same stale walletBalance
        // and one credit would be silently lost.
        await tx.customer.update({
          where: { id: order.customerId },
          data: { walletBalance: { increment: dto.amount } },
        });
      }

      return created;
    });

    this.realtime.emitToBranch(branchId, 'order.updated', { id: orderId });

    await this.audit.record({
      userId,
      action: 'order.refunded',
      entity: 'Order',
      entityId: orderId,
      metadata: {
        orderNumber: order.orderNumber,
        amount: dto.amount,
        method: dto.method,
        reason: dto.reason,
      },
    });

    return refund;
  }

  async mergeOrders(
    branchId: string,
    targetOrderId: string,
    sourceOrderId: string,
  ) {
    if (targetOrderId === sourceOrderId) {
      throw new BadRequestException('Cannot merge an order into itself');
    }
    const [target, source] = await Promise.all([
      this.prisma.order.findFirst({
        where: { id: targetOrderId, branchId },
        include: { payments: { select: { id: true } } },
      }),
      this.prisma.order.findFirst({
        where: { id: sourceOrderId, branchId },
        include: { payments: { select: { id: true } } },
      }),
    ]);
    if (!target || !source) throw new NotFoundException('Order not found');
    if (target.status !== 'OPEN' || source.status !== 'OPEN') {
      throw new BadRequestException('Both orders must be open to merge');
    }
    this.assertNoPayments(target);
    this.assertNoPayments(source);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.updateMany({
        where: { orderId: sourceOrderId },
        data: { orderId: targetOrderId },
      });
      await tx.kot.updateMany({
        where: { orderId: sourceOrderId },
        data: { orderId: targetOrderId },
      });

      const items = await tx.orderItem.findMany({
        where: { orderId: targetOrderId },
      });
      const lines = items.map((item) =>
        priceLine({
          quantity: item.quantity,
          unitPriceInclusive: Number(item.lineTotal) / item.quantity,
          taxRatePercent: Number(item.taxRateSnapshot),
        }),
      );
      // Discount is intentionally not recomputed here — it's re-entered at
      // checkout time for the merged bill, same as any other order.
      const totals = computeOrderTotals(lines);

      const result = await tx.order.update({
        where: { id: targetOrderId },
        data: {
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          totalAmount: totals.subtotal,
        },
        include: { items: true },
      });

      await tx.order.update({
        where: { id: sourceOrderId },
        data: {
          status: 'CANCELLED',
          notes: `Merged into order ${target.orderNumber}`,
        },
      });

      if (source.tableId && source.tableId !== target.tableId) {
        await this.releaseTableIfIdle(tx, source.tableId, sourceOrderId);
      }

      return result;
    });

    this.realtime.emitToBranch(branchId, 'order.updated', {
      id: targetOrderId,
    });
    this.realtime.emitToBranch(branchId, 'order.updated', {
      id: sourceOrderId,
    });
    return this.getOrder(branchId, updated.id);
  }

  private buildLine(
    cartItem: CartItemDto,
    menuItemById: Map<string, Prisma.MenuItemGetPayload<Record<string, never>>>,
    modifierById: Map<string, Prisma.ModifierGetPayload<Record<string, never>>>,
    taxMode: TaxMode,
    allowCustomPortion: boolean,
  ) {
    const menuItem = menuItemById.get(cartItem.menuItemId);
    if (!menuItem) throw new BadRequestException('Menu item not found');

    // Portion decides the base price and a label baked into the name
    // snapshot, so KOTs, receipts, KDS and reports all show "(Half)" etc.
    let portionBase = Number(menuItem.price);
    let portionSuffix = '';
    let sizeName: string | null = null;
    let weightKg: number | null = null;
    if (cartItem.sizeId) {
      const size = (
        menuItem as typeof menuItem & {
          sizes?: { id: string; name: string; price: { toString(): string } | number }[];
        }
      ).sizes?.find((row) => row.id === cartItem.sizeId);
      if (!size) {
        throw new BadRequestException(`${menuItem.name} does not have that size`);
      }
      portionBase = Number(size.price);
      sizeName = size.name;
      portionSuffix = ` (${size.name})`;
    }
    if (cartItem.portion === 'HALF' || cartItem.portion === 'FULL') {
      if (menuItem.halfPrice == null) {
        throw new BadRequestException(
          `${menuItem.name} has no half/full portions`,
        );
      }
      if (cartItem.portion === 'HALF') portionBase = Number(menuItem.halfPrice);
      // Staff may type their own price for Half/Full too.
      if (allowCustomPortion && cartItem.customPrice != null) {
        portionBase = cartItem.customPrice;
      }
      portionSuffix = cartItem.portion === 'HALF' ? ' (Half)' : ' (Full)';
    } else if (cartItem.portion === 'CUSTOM') {
      if (!allowCustomPortion) {
        throw new BadRequestException('Custom portions are staff-only');
      }
      if (cartItem.customPrice == null) {
        throw new BadRequestException('Custom portion needs a price');
      }
      portionBase = cartItem.customPrice;
      portionSuffix = ` (${cartItem.customLabel || 'Custom'})`;
    }
    if (menuItem.soldByWeight) {
      if (cartItem.weightKg == null) {
        throw new BadRequestException(
          `${menuItem.name} is sold by weight. Enter the kilograms.`,
        );
      }
      weightKg = cartItem.weightKg;
      portionSuffix += ` (${weightKg.toFixed(3)} kg)`;
    }
    const portionStep = Number(
      (menuItem as { portionStep?: { toString(): string } | number }).portionStep ?? 1,
    );
    const soldAmount = weightKg ?? cartItem.quantity;
    if (violatesPortionStep(soldAmount, portionStep)) {
      throw new BadRequestException(
        `${menuItem.name} is sold in steps of ${portionStep}`,
      );
    }
    const portionFactor = salePortionFactor(cartItem.portion);

    const selectedModifiers = cartItem.modifierIds.map((id) => {
      const modifier = modifierById.get(id);
      if (!modifier) throw new BadRequestException('Modifier not found');
      return modifier;
    });

    const basePrice = portionBase;
    const modifierTotal = selectedModifiers.reduce(
      (sum, m) => sum + Number(m.priceAdjustment),
      0,
    );
    const taxRatePercent = Number(menuItem.taxRatePercent);
    // In EXCLUSIVE mode (US sales tax) menuItem.price + modifiers is the
    // pre-tax price, so it's grossed up to the inclusive amount here — the
    // one conversion point; everything past this line (priceLine, the
    // stored lineTotal/unitPriceSnapshot, receipts) works off that
    // inclusive figure exactly as the original India-only pricing did, so
    // "qty × unit price" on a receipt still reconciles to the line total.
    const unitPriceInclusive = toEffectiveInclusiveUnitPrice(
      round2(basePrice + modifierTotal),
      taxRatePercent,
      taxMode,
    );
    const staffPrice = allowCustomPortion;
    const complimentary = staffPrice && !!cartItem.complimentary;
    const discountPercent = complimentary
      ? 100
      : staffPrice
        ? (cartItem.discountPercent ?? 0)
        : 0;
    const chargedUnit = complimentary
      ? 0
      : discountPercent > 0
        ? round2(unitPriceInclusive * (1 - discountPercent / 100))
        : unitPriceInclusive;

    const priced = priceLine({
      quantity: weightKg ?? cartItem.quantity,
      unitPriceInclusive: chargedUnit,
      taxRatePercent,
    });

    return {
      cartItem,
      weightKg,
      portionFactor,
      guestNumber: staffPrice ? (cartItem.guestNumber ?? 1) : 1,
      complimentary,
      discountPercent,
      hsnCode: menuItem.hsnCode,
      sizeName,
      menuItem: {
        id: menuItem.id,
        name: menuItem.name + portionSuffix,
        price: unitPriceInclusive - round2(modifierTotal),
        taxRatePercent,
      },
      selectedModifiers,
      priced,
    };
  }

  private birthdayOffer(
    restaurant: {
      birthdayDiscountPercent: Prisma.Decimal | number;
      timezone: string;
    },
    customer: { birthday: Date | null; birthdayOfferYear: number | null } | null,
  ) {
    const percent = Number(restaurant.birthdayDiscountPercent);
    if (!customer?.birthday || percent <= 0) {
      return { percent: 0, birthdayApplied: false };
    }
    const now = new Date();
    const month = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: restaurant.timezone,
        month: 'numeric',
      }).format(now),
    );
    const year = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: restaurant.timezone,
        year: 'numeric',
      }).format(now),
    );
    if (
      customer.birthday.getUTCMonth() + 1 !== month ||
      customer.birthdayOfferYear === year
    ) {
      return { percent: 0, birthdayApplied: false };
    }
    return { percent, birthdayApplied: true };
  }

  private async awardLoyalty(
    tx: Prisma.TransactionClient,
    input: {
      customerId: string;
      restaurantId: string;
      branchId: string;
      timezone: string;
      referralPoints: number;
      earnPerCurrency: number;
      netSpend: number;
      lines: { menuItemId: string; lineTotal: number }[];
      birthdayApplied: boolean;
    },
  ) {
    const guest = await tx.customer.findUnique({
      where: { id: input.customerId },
    });
    if (!guest) return;
    const tiers = await tx.membershipTier.findMany({
      where: { restaurantId: input.restaurantId },
      orderBy: { minPoints: 'desc' },
    });
    // Earn at the tier the balance already qualifies for, including a
    // zero-point entry tier. The next tier is applied after this bill.
    const starting = tiers.find((row) => guest.loyaltyPoints >= row.minPoints);
    const multiplier = starting ? Number(starting.earnMultiplier) : 1;
    const rule = await tx.loyaltyRule.findUnique({ where: { branchId: input.branchId } });
    const eligibleSpend = spendForLoyalty({
      lines: input.lines,
      eligibleMenuItemIds: rule?.eligibleMenuItemIds ?? [],
      netSpend: input.netSpend,
    });
    const pointsEarned = earnPoints({
      eligibleSpend,
      earnPerCurrency: rule?.earnPerCurrency ?? input.earnPerCurrency,
      multiplier,
      cap: rule?.maxEarnPerOrder ?? null,
    });
    const cashback = earnCashback({
      eligibleSpend,
      percent: rule ? Number(rule.cashbackPercent) : 0,
      cap: rule?.cashbackCap == null ? null : Number(rule.cashbackCap),
    });
    if (pointsEarned > 0 || cashback > 0) {
      await tx.customer.update({
        where: { id: guest.id },
        data: {
          ...(pointsEarned > 0 ? { loyaltyPoints: { increment: pointsEarned } } : {}),
          ...(cashback > 0 ? { cashbackBalance: { increment: cashback } } : {}),
        },
      });
    }
    if (pointsEarned > 0) {
      const expiresAt =
        rule?.expiryDays != null
          ? new Date(Date.now() + rule.expiryDays * 86_400_000)
          : null;
      await tx.pointLot.create({
        data: {
          customerId: guest.id,
          pointsRemaining: pointsEarned,
          expiresAt,
        },
      });
    }
    if (input.birthdayApplied) {
      const year = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: input.timezone,
          year: 'numeric',
        }).format(new Date()),
      );
      await tx.customer.update({
        where: { id: guest.id },
        data: { birthdayOfferYear: year },
      });
    }
    if (
      guest.referredById &&
      guest.referredById !== guest.id &&
      !guest.referralRewarded
    ) {
      if (input.referralPoints > 0) {
        await tx.customer.update({
          where: { id: guest.referredById },
          data: { loyaltyPoints: { increment: input.referralPoints } },
        });
        await tx.pointLot.create({
          data: {
            customerId: guest.referredById,
            pointsRemaining: input.referralPoints,
          },
        });
      }
      await tx.customer.update({
        where: { id: guest.id },
        data: { referralRewarded: true },
      });
    }
    const balance = guest.loyaltyPoints + Math.max(pointsEarned, 0);
    const tier = tiers.find((row) => balance >= row.minPoints);
    if (tier && tier.id !== guest.tierId) {
      await tx.customer.update({
        where: { id: guest.id },
        data: { tierId: tier.id },
      });
    }
  }

  // Next number for today: highest existing sequence + 1, not a row count. A
  // count collides with an existing number as soon as any earlier order of the
  // day has been deleted (orders.delete), and that surfaced as a 409 on the
  // unique (branchId, orderNumber) index.
  private async nextOrderNumber(
    branchId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string> {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const latest = await db.order.findFirst({
      where: { branchId, orderNumber: { startsWith: `${datePart}-` } },
      orderBy: { orderNumber: 'desc' },
      select: { orderNumber: true },
    });
    const last = latest ? Number(latest.orderNumber.split('-')[1]) : 0;
    const next = (Number.isFinite(last) ? last : 0) + 1;
    return `${datePart}-${String(next).padStart(4, '0')}`;
  }

  /**
   * Every selected modifier must belong to a group attached to that menu
   * item in this branch — otherwise a caller could price an item with some
   * other item's (or another tenant's) modifiers. For guest-facing orders
   * the group's min/max/required limits are enforced too.
   */
  private async validateModifierSelections(
    branchId: string,
    items: CartItemDto[],
    enforceLimits: boolean,
  ) {
    if (!enforceLimits && items.every((i) => i.modifierIds.length === 0))
      return;
    const links = await this.prisma.menuItemModifierGroup.findMany({
      where: {
        menuItemId: { in: [...new Set(items.map((i) => i.menuItemId))] },
        modifierGroup: { branchId },
      },
      include: {
        modifierGroup: { include: { modifiers: { select: { id: true } } } },
      },
    });
    for (const item of items) {
      const groups = links
        .filter((l) => l.menuItemId === item.menuItemId)
        .map((l) => l.modifierGroup);
      const allowed = new Set(
        groups.flatMap((g) => g.modifiers.map((m) => m.id)),
      );
      if (item.modifierIds.some((id) => !allowed.has(id))) {
        throw new BadRequestException(
          'A selected option is not available for this item',
        );
      }
      if (!enforceLimits) continue;
      for (const g of groups) {
        const picked = item.modifierIds.filter((id) =>
          g.modifiers.some((m) => m.id === id),
        ).length;
        const min = g.isRequired ? Math.max(1, g.minSelect) : g.minSelect;
        if (picked < min || picked > g.maxSelect) {
          throw new BadRequestException(
            `Choose ${min === g.maxSelect ? min : `${min}–${g.maxSelect}`} option(s) for "${g.name}"`,
          );
        }
      }
    }
  }

  /** True when a scheduled order is still too far off to cook. */
  private isDeferred(scheduledFor?: Date): boolean {
    return (
      !!scheduledFor &&
      scheduledFor.getTime() > Date.now() + OrdersService.SCHEDULE_LEAD_MS
    );
  }

  private static readonly SCHEDULE_LEAD_MS = 25 * 60_000;

  /**
   * Sends scheduled orders to the kitchen once they are within the lead
   * window. Safe to call repeatedly: an order that already has tickets (or
   * is still awaiting acceptance / was rejected) is skipped.
   */
  async releaseDueScheduledOrders(): Promise<number> {
    const due = await this.prisma.order.findMany({
      where: {
        status: 'OPEN',
        acceptance: { in: ['NOT_REQUIRED', 'ACCEPTED'] },
        scheduledFor: {
          lte: new Date(Date.now() + OrdersService.SCHEDULE_LEAD_MS),
        },
        kots: { none: {} },
      },
      include: { items: true },
    });
    for (const order of due) {
      await this.prisma.$transaction((tx) =>
        this.generateKots(tx, order.id, order.branchId, order.items),
      );
      this.realtime.emitToBranch(order.branchId, 'kot.updated', {
        orderId: order.id,
      });
      try {
        await this.notifications.notifyByPermission(
          order.branchId,
          'kds.manage',
          {
            type: 'order.new',
            title: 'Scheduled order is due',
            body: `Order ${order.orderNumber} (${order.type.replace('_', ' ')})`,
            entity: 'Order',
            entityId: order.id,
          },
        );
      } catch (err) {
        this.logger.warn(
          `Failed to notify scheduled order ${order.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return due.length;
  }

  /**
   * After a line moves to another bill, kitchen tickets stay on the source
   * order unless they are moved too. Whole tickets follow the line; a ticket
   * that still has other lines is split so each bill keeps its own KOT.
   */
  private async reattachKotItems(
    tx: Prisma.TransactionClient,
    branchId: string,
    orderItemIds: string[],
    targetOrderId: string,
  ) {
    if (orderItemIds.length === 0) return;
    const movingIds = new Set(orderItemIds);
    const kotItems = await tx.kotItem.findMany({
      where: { orderItemId: { in: orderItemIds } },
      include: { kot: { include: { items: true } } },
    });
    const seen = new Set<string>();
    let ticketSeq = (await tx.kot.count({ where: { orderId: targetOrderId } })) + 1;
    for (const row of kotItems) {
      if (seen.has(row.kotId)) continue;
      seen.add(row.kotId);
      const moving = row.kot.items.filter((item) => movingIds.has(item.orderItemId));
      const staying = row.kot.items.filter((item) => !movingIds.has(item.orderItemId));
      if (moving.length === 0) continue;
      if (staying.length === 0) {
        await tx.kot.update({
          where: { id: row.kot.id },
          data: { orderId: targetOrderId },
        });
        this.realtime.emitToBranch(branchId, 'kot.updated', { id: row.kot.id });
        continue;
      }
      const created = await tx.kot.create({
        data: {
          orderId: targetOrderId,
          stationId: row.kot.stationId,
          ticketNumber: `${targetOrderId.slice(-6)}-${ticketSeq++}`,
          status: row.kot.status,
          isPriority: row.kot.isPriority,
          acceptedAt: row.kot.acceptedAt,
          readyAt: row.kot.readyAt,
          servedAt: row.kot.servedAt,
          acceptedById: row.kot.acceptedById,
        },
      });
      await tx.kotItem.updateMany({
        where: { id: { in: moving.map((item) => item.id) } },
        data: { kotId: created.id },
      });
      this.realtime.emitToBranch(branchId, 'kot.created', {
        id: created.id,
        stationId: row.kot.stationId,
      });
      this.realtime.emitToBranch(branchId, 'kot.updated', { id: row.kot.id });
    }
  }

  private async generateKots(
    tx: Prisma.TransactionClient,
    orderId: string,
    branchId: string,
    orderItems: { id: string; menuItemId: string }[],
  ) {
    const stationLookup = await tx.menuItem.findMany({
      where: { id: { in: orderItems.map((i) => i.menuItemId) } },
      select: {
        id: true,
        stationId: true,
        courseId: true,
        course: { select: { holdByDefault: true } },
      },
    });
    const routeByMenuItem = new Map(
      stationLookup.map((m) => [
        m.id,
        {
          stationId: m.stationId,
          courseId: m.courseId,
          held: Boolean(m.course?.holdByDefault),
        },
      ]),
    );

    const buckets = new Map<
      string,
      { stationId: string | null; courseId: string | null; held: boolean; items: typeof orderItems }
    >();
    for (const item of orderItems) {
      const route = routeByMenuItem.get(item.menuItemId) ?? {
        stationId: null,
        courseId: null,
        held: false,
      };
      const key = `${route.stationId ?? ''}::${route.courseId ?? ''}`;
      const bucket = buckets.get(key) ?? {
        stationId: route.stationId,
        courseId: route.courseId,
        held: route.held,
        items: [],
      };
      bucket.items.push(item);
      buckets.set(key, bucket);
    }

    // Start after any KOTs this order already has — addItems() can call this
    // a second time for a later round, and ticket numbers must stay unique
    // per order for kitchen staff to tell rounds apart.
    let ticketSeq = (await tx.kot.count({ where: { orderId } })) + 1;
    for (const bucket of buckets.values()) {
      const kot = await tx.kot.create({
        data: {
          orderId,
          stationId: bucket.stationId ?? undefined,
          courseId: bucket.courseId ?? undefined,
          held: bucket.held,
          ticketNumber: `${orderId.slice(-6)}-${ticketSeq++}`,
          items: { create: bucket.items.map((item) => ({ orderItemId: item.id })) },
        },
      });
      this.realtime.emitToBranch(branchId, 'kot.created', {
        id: kot.id,
        stationId: bucket.stationId,
      });
    }
  }

  // Moves a kitchen ticket one step forward (NEW -> ACCEPTED -> PREPARING ->
  // READY -> SERVED). The move is checked against the shared state machine and
  // applied as a compare-and-set on the status the caller saw, so a stale
  // screen or a double tap can neither skip a step nor repeat one. Asking for
  // the status the ticket already has is a harmless no-op (no second
  // timestamp, event or notification).
  async updateKotStatus(
    branchId: string,
    kotId: string,
    status: string,
    userId?: string,
  ) {
    if (!(KOT_FORWARD_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(
        'A ticket can only move to accepted, preparing, ready or served - use reject to decline it',
      );
    }
    const target = status as (typeof KOT_FORWARD_STATUSES)[number];
    const kot = await this.prisma.kot.findFirst({
      where: { id: kotId, order: { branchId } },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            table: { select: { assignedWaiterId: true, number: true } },
          },
        },
      },
    });
    if (!kot) throw new NotFoundException('KOT not found');
    if (kot.status === target) return kot;
    if (!canTransitionKot(kot.status, target)) {
      throw new ConflictException(
        `This ticket is ${kot.status.toLowerCase()} - it cannot move to ${target.toLowerCase()}. Refresh to see its current state.`,
      );
    }

    const now = new Date();
    const stamps: Prisma.KotUpdateManyMutationInput = {};
    if (target === 'ACCEPTED') stamps.acceptedAt = now;
    if (target === 'READY') stamps.readyAt = now;
    if (target === 'SERVED') stamps.servedAt = now;
    if (target === 'PREPARING' && (kot.status === 'READY' || kot.status === 'SERVED')) {
      stamps.readyAt = null;
      stamps.servedAt = null;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.kot.updateMany({
        where: { id: kotId, status: kot.status },
        data: {
          status: target,
          ...stamps,
          ...(target === 'ACCEPTED' && userId ? { acceptedById: userId } : {}),
        },
      });
      if (moved.count === 0) {
        throw new ConflictException(
          'This ticket was just updated by someone else - refresh to see its current state',
        );
      }
      await tx.kotItem.updateMany({
        where: { kotId },
        data: { status: target },
      });
      return tx.kot.findUniqueOrThrow({ where: { id: kotId } });
    });

    this.realtime.emitToBranch(branchId, 'kot.updated', updated);
    this.realtime.emitToBranch(branchId, 'order.updated', {
      id: kot.order.id,
    });
    await this.audit.record({
      userId,
      action: 'kot.status_changed',
      entity: 'Kot',
      entityId: kotId,
      metadata: {
        orderNumber: kot.order.orderNumber,
        ticketNumber: kot.ticketNumber,
        from: kot.status,
        to: target,
      },
    });

    // Waiter assignment lives on Table (assignedWaiterId), not Order — a
    // KOT's order carries a table only for dine-in; takeaway/delivery orders
    // have no table and therefore no assigned waiter to notify, which is
    // exactly the "skip silently if not set" case.
    const assignedWaiterId = kot.order.table?.assignedWaiterId;
    if (target === 'READY' && assignedWaiterId) {
      try {
        await this.notifications.notifyUser(assignedWaiterId, branchId, {
          type: 'order.ready',
          title: 'Order ready',
          body: kot.order.table
            ? `Order ${kot.order.orderNumber} — Table ${kot.order.table.number} is ready to serve`
            : `Order ${kot.order.orderNumber} is ready to serve`,
          entity: 'Order',
          entityId: kot.order.id,
        });
      } catch (err) {
        this.logger.warn(
          `Failed to send order.ready notification for order ${kot.order.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return updated;
  }

  async updateKotItemStatus(
    branchId: string,
    kotItemId: string,
    status: string,
    delayReason?: string,
  ) {
    const allowed = ['ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'DELAYED'];
    if (!allowed.includes(status)) {
      throw new BadRequestException('That line status is not allowed');
    }
    const line = await this.prisma.kotItem.findFirst({
      where: { id: kotItemId, kot: { order: { branchId } } },
      include: { kot: { include: { items: true, order: { select: { id: true } } } } },
    });
    if (!line) throw new NotFoundException('Kitchen line not found');
    if (line.kot.status === 'CANCELLED' || line.kot.status === 'REJECTED') {
      throw new BadRequestException('This ticket is no longer live');
    }
    await this.prisma.kotItem.update({
      where: { id: kotItemId },
      data: {
        status: status as never,
        delayReason: status === 'DELAYED' ? delayReason?.trim() || null : null,
        ...(status === 'DELAYED' ? { wasDelayed: true } : {}),
      },
    });
    const items = await this.prisma.kotItem.findMany({ where: { kotId: line.kotId } });
    const rolled = rollupKotStatus(items);
    if (rolled && rolled !== line.kot.status) {
      const now = new Date();
      await this.prisma.kot.update({
        where: { id: line.kotId },
        data: {
          status: rolled as never,
          ...(rolled === 'ACCEPTED' ? { acceptedAt: line.kot.acceptedAt ?? now } : {}),
          ...(rolled === 'READY' ? { readyAt: now } : {}),
          ...(rolled === 'SERVED' ? { servedAt: now } : {}),
          ...(rolled === 'PREPARING' && (line.kot.status === 'READY' || line.kot.status === 'SERVED')
            ? { readyAt: null, servedAt: null }
            : {}),
        },
      });
    }
    const updated = await this.prisma.kot.findUniqueOrThrow({
      where: { id: line.kotId },
      include: { items: { include: { orderItem: { include: { modifiers: true } } } } },
    });
    this.realtime.emitToBranch(branchId, 'kot.updated', updated);
    this.realtime.emitToBranch(branchId, 'order.updated', { id: line.kot.order.id });
    return updated;
  }

  async setKotHeld(branchId: string, kotId: string, held: boolean) {
    const kot = await this.prisma.kot.findFirst({
      where: { id: kotId, order: { branchId } },
    });
    if (!kot) throw new NotFoundException('KOT not found');
    if (kot.status === 'CANCELLED' || kot.status === 'REJECTED' || kot.status === 'SERVED') {
      throw new BadRequestException('This ticket cannot be held or fired');
    }
    const updated = await this.prisma.kot.update({
      where: { id: kotId },
      data: { held, firedAt: held ? null : new Date() },
    });
    this.realtime.emitToBranch(branchId, 'kot.updated', updated);
    return updated;
  }

  async assembleExpo(branchId: string, orderId: string) {
    const kots = await this.prisma.kot.findMany({
      where: {
        orderId,
        order: { branchId },
        status: { notIn: ['CANCELLED', 'REJECTED'] },
      },
    });
    if (kots.length === 0) throw new NotFoundException('No kitchen tickets for this order');
    const live = kots.filter((kot) => kot.status !== 'SERVED');
    if (live.some((kot) => kot.held || kot.status !== 'READY')) {
      throw new BadRequestException('Every live ticket must be ready and fired before Expo can assemble');
    }
    const now = new Date();
    await this.prisma.kot.updateMany({
      where: { id: { in: kots.map((kot) => kot.id) } },
      data: { expoAssembledAt: now },
    });
    this.realtime.emitToBranch(branchId, 'order.updated', { id: orderId });
    return { orderId, assembledAt: now };
  }

  /** Releases every held ticket of one course on an order. */
  async fireCourse(branchId: string, orderId: string, courseId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    const course = await this.prisma.kitchenCourse.findFirst({
      where: { id: courseId, branchId },
      select: { id: true },
    });
    if (!course) throw new NotFoundException('Kitchen course not found');
    const held = await this.prisma.kot.findMany({
      where: {
        orderId,
        courseId,
        held: true,
        status: { notIn: ['CANCELLED', 'REJECTED', 'SERVED'] },
      },
      select: { id: true },
    });
    if (held.length === 0) {
      throw new BadRequestException('That course has no held tickets');
    }
    const firedAt = new Date();
    await this.prisma.kot.updateMany({
      where: { id: { in: held.map((kot) => kot.id) } },
      data: { held: false, firedAt },
    });
    for (const kot of held) {
      this.realtime.emitToBranch(branchId, 'kot.updated', { id: kot.id, held: false, firedAt });
    }
    this.realtime.emitToBranch(branchId, 'order.updated', { id: orderId });
    return { orderId, courseId, fired: held.length, firedAt };
  }

  /** Hands an assembled order to the floor by marking every live ticket served. */
  async passExpo(branchId: string, orderId: string, userId?: string) {
    const kots = await this.prisma.kot.findMany({
      where: {
        orderId,
        order: { branchId },
        status: { notIn: ['CANCELLED', 'REJECTED', 'SERVED'] },
      },
    });
    if (kots.length === 0) throw new NotFoundException('No live kitchen tickets for this order');
    if (kots.some((kot) => kot.held || kot.status !== 'READY' || !kot.expoAssembledAt)) {
      throw new BadRequestException('Assemble the order before passing it to the floor');
    }
    for (const kot of kots) {
      await this.updateKotStatus(branchId, kot.id, 'SERVED', userId);
    }
    return { orderId, passed: kots.length };
  }

  // The kitchen declining a ticket. It is never a silent disappearance: the
  // ticket is kept as REJECTED with who/when/why, the guest-facing order is
  // updated to match, and an audit row is written.
  //   - NEW / ACCEPTED: any kitchen user may reject.
  //   - PREPARING: food is already in progress, so the caller must confirm it
  //     explicitly and hold orders.cancel as well (checked by the controller
  //     via `mayRejectStarted`).
  //   - READY / SERVED / already withdrawn: not rejectable.
  // If this was the order's only live ticket and nothing is paid, the whole
  // order is withdrawn (source KITCHEN_REJECTED) so the table is freed and the
  // order stops showing as open. If other rounds are still live, only this
  // ticket's lines come off the bill.
  async rejectKot(
    branchId: string,
    kotId: string,
    userId: string,
    input: {
      reason: string;
      confirmStarted?: boolean;
      mayRejectStarted: boolean;
    },
  ) {
    const reason = input.reason.trim();
    if (!reason) throw new BadRequestException('A reason is required');
    const kot = await this.prisma.kot.findFirst({
      where: { id: kotId, order: { branchId } },
      include: {
        items: { include: { orderItem: true } },
        order: { include: { kots: true, payments: true } },
      },
    });
    if (!kot) throw new NotFoundException('KOT not found');
    const current = kot.status;
    if (current === 'REJECTED') return kot;
    if (!canTransitionKot(current, 'REJECTED')) {
      throw new ConflictException(
        `This ticket is ${current.toLowerCase()} - it can no longer be rejected`,
      );
    }
    const started = (KOT_STARTED_STATUSES as readonly string[]).includes(
      current,
    );
    if (started) {
      if (!input.mayRejectStarted) {
        throw new ForbiddenException(
          'The kitchen has already started this ticket - only a manager can reject it',
        );
      }
      if (!input.confirmStarted) {
        throw new ConflictException({
          statusCode: 409,
          code: 'KITCHEN_STARTED',
          message:
            'This ticket is already being prepared. Confirm to reject it anyway - the food in progress will be wasted.',
        });
      }
    }
    const order = kot.order;
    if (order.status !== 'OPEN') {
      throw new ConflictException('This order is no longer open');
    }
    if (order.payments.length > 0) {
      throw new BadRequestException(
        'This order already has a payment - refund it instead of rejecting a ticket',
      );
    }

    const otherLive = order.kots.some(
      (k) => k.id !== kotId && !['CANCELLED', 'REJECTED'].includes(k.status),
    );
    const lineIds = kot.items.map((i) => i.orderItemId);
    const rejectedLines = kot.items.map((i) => ({
      item: i.orderItem.nameSnapshot,
      quantity: i.orderItem.quantity,
      lineTotal: i.orderItem.lineTotal.toString(),
    }));

    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.kot.updateMany({
        where: { id: kotId, status: kot.status },
        data: {
          status: 'REJECTED',
          rejectedAt: new Date(),
          rejectedById: userId,
          rejectReason: reason,
        },
      });
      if (moved.count === 0) {
        throw new ConflictException(
          'This ticket was just updated by someone else - refresh to see its current state',
        );
      }
      await tx.kotItem.updateMany({
        where: { kotId },
        data: { status: 'CANCELLED' },
      });

      if (!otherLive) {
        const flipped = await tx.order.updateMany({
          where: { id: order.id, status: 'OPEN' },
          data: {
            status: 'CANCELLED',
            cancelReason: reason,
            cancelledAt: new Date(),
            cancelledById: userId,
            cancelSource: 'KITCHEN_REJECTED',
          },
        });
        if (flipped.count === 0) {
          throw new ConflictException(
            'This order was just paid or changed - refresh and check it',
          );
        }
        await this.releaseTableIfIdle(tx, order.tableId, order.id);
        return;
      }

      // Another round is still being worked: take only this ticket's lines
      // off the bill so the guest is not charged for what was refused. Its
      // KotItem rows are removed with the lines, so the rejected lines are
      // preserved in the audit snapshot below.
      if (lineIds.length > 0) {
        await tx.orderItem.deleteMany({ where: { id: { in: lineIds } } });
        await this.recomputeTotals(tx, order.id);
      }
    });

    this.realtime.emitToBranch(branchId, 'kot.updated', {
      id: kotId,
      orderId: order.id,
      status: 'REJECTED',
    });
    this.emitOrderWithdrawn(
      branchId,
      order.id,
      otherLive ? null : order.tableId,
    );
    if (otherLive) {
      this.realtime.emitToBranch(branchId, 'order.updated', { id: order.id });
    }
    await this.audit.record({
      userId,
      action: 'kot.rejected',
      entity: 'Kot',
      entityId: kotId,
      metadata: {
        orderNumber: order.orderNumber,
        ticketNumber: kot.ticketNumber,
        from: current,
        reason,
        wholeOrderCancelled: !otherLive,
        kitchenStarted: started,
        lines: rejectedLines,
      },
    });

    try {
      await this.notifications.notifyByPermission(branchId, 'orders.create', {
        type: 'order.rejected',
        title: 'Kitchen rejected a ticket',
        body: `Order ${order.orderNumber}: ${reason}`,
        entity: 'Order',
        entityId: order.id,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to notify staff of rejected ticket ${kotId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return this.prisma.kot.findUniqueOrThrow({ where: { id: kotId } });
  }

  async setKotPriority(branchId: string, kotId: string, isPriority: boolean) {
    const kot = await this.prisma.kot.findFirst({
      where: { id: kotId, order: { branchId } },
    });
    if (!kot) throw new NotFoundException('KOT not found');

    const updated = await this.prisma.kot.update({
      where: { id: kotId },
      data: { isPriority },
    });
    this.realtime.emitToBranch(branchId, 'kot.updated', updated);
    return updated;
  }

  async resumeHeld(branchId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      include: { items: true, kots: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'OPEN') {
      throw new BadRequestException('Only an open order can be resumed');
    }
    if (!order.heldAt) {
      throw new BadRequestException('This order is not on hold');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { heldAt: null },
      });
      if (order.kots.length === 0) {
        await this.generateKots(tx, orderId, branchId, order.items);
      }
    });
    this.realtime.emitToBranch(branchId, 'order.updated', { id: orderId });
    return this.getOrder(branchId, orderId);
  }

  async lastPaidForCustomer(branchId: string, customerId?: string) {
    if (!customerId) {
      throw new BadRequestException('Select a customer first');
    }
    const last = await this.prisma.order.findFirst({
      where: { branchId, customerId, status: 'PAID' },
      orderBy: { billedAt: 'desc' },
      include: { items: { include: { modifiers: true } } },
    });
    if (!last) throw new NotFoundException('No previous paid order for this guest');
    return last;
  }

  async repeatItems(branchId: string, userId: string, customerId: string, itemIds: string[]) {
    const last = await this.lastPaidForCustomer(branchId, customerId);
    const picked = itemIds.length
      ? last.items.filter((item) => itemIds.includes(item.id))
      : last.items;
    if (picked.length === 0) throw new BadRequestException('Choose at least one dish');
    const sizes = await this.prisma.menuItemSize.findMany({
      where: { menuItemId: { in: picked.map((item) => item.menuItemId) } },
      select: { id: true, menuItemId: true, name: true },
    });
    return this.createOrder(branchId, userId, {
      type: last.tableId ? 'DINE_IN' : 'TAKEAWAY',
      tableId: last.tableId ?? undefined,
      customerId,
      guestName: last.guestName ?? undefined,
      guestCount: last.guestCount && last.guestCount > 0 ? last.guestCount : undefined,
      notes: `Repeat of ${last.orderNumber}`,
      items: picked.map((item) => {
        const size = item.sizeName
          ? sizes.find((row) => row.menuItemId === item.menuItemId && row.name === item.sizeName)
          : undefined;
        return {
          menuItemId: item.menuItemId,
          quantity: item.quantity,
          modifierIds: item.modifiers.map((modifier) => modifier.modifierId),
          kitchenNote: item.kitchenNote ?? undefined,
          ...(Number(item.portionFactor) === 0.5 ? { portion: 'HALF' as const } : {}),
          ...(size ? { sizeId: size.id } : {}),
        };
      }),
    });
  }

  async moveItem(
    branchId: string,
    sourceOrderId: string,
    userId: string,
    dto: { orderItemId: string; targetOrderId: string },
  ) {
    if (dto.targetOrderId === sourceOrderId) {
      throw new BadRequestException('That line is already on this bill');
    }
    const source = await this.prisma.order.findFirst({
      where: { id: sourceOrderId, branchId },
      include: { items: true, payments: { select: { id: true } } },
    });
    const target = await this.prisma.order.findFirst({
      where: { id: dto.targetOrderId, branchId },
      include: { items: true, payments: { select: { id: true } } },
    });
    if (!source || !target) throw new NotFoundException('Order not found');
    if (source.status !== 'OPEN' || target.status !== 'OPEN') {
      throw new BadRequestException('Both bills must be open');
    }
    this.assertNoPayments(source);
    this.assertNoPayments(target);
    const line = source.items.find((item) => item.id === dto.orderItemId);
    if (!line) throw new NotFoundException('Line not found on this bill');
    if (source.items.length < 2) {
      throw new BadRequestException('Leave at least one line on the source bill');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.update({
        where: { id: line.id },
        data: { orderId: target.id },
      });
      await this.reattachKotItems(tx, branchId, [line.id], target.id);
      await this.recalcOpenTotals(tx, source.id);
      await this.recalcOpenTotals(tx, target.id);
    });
    this.realtime.emitToBranch(branchId, 'order.updated', { id: source.id });
    this.realtime.emitToBranch(branchId, 'order.updated', { id: target.id });
    return this.getOrder(branchId, source.id);
  }

  private async recalcOpenTotals(tx: Prisma.TransactionClient, orderId: string) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    const subtotal = round2(
      items.reduce((sum, item) => sum + Number(item.lineTotal), 0),
    );
    const taxAmount = round2(
      items.reduce((sum, item) => {
        const rate = Number(item.taxRateSnapshot);
        const line = Number(item.lineTotal);
        const tax = rate > 0 ? line - line / (1 + rate / 100) : 0;
        return sum + tax;
      }, 0),
    );
    await tx.order.update({
      where: { id: orderId },
      data: { subtotal, taxAmount, totalAmount: subtotal },
    });
  }

  async splitGuests(branchId: string, orderId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      include: { items: true, payments: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'OPEN') {
      throw new BadRequestException('Only an open order can be split');
    }
    this.assertNoPayments(order);
    const groups = new Map<number, string[]>();
    for (const item of order.items) {
      const bucket = groups.get(item.guestNumber) ?? [];
      bucket.push(item.id);
      groups.set(item.guestNumber, bucket);
    }
    const numbers = [...groups.keys()].sort((a, b) => a - b);
    if (numbers.length < 2) {
      throw new BadRequestException(
        'Every line is the same guest. Set a guest number on a line first.',
      );
    }
    const created: { id: string; orderNumber: string; guestNumber: number }[] =
      [];
    await this.prisma.$transaction(async (tx) => {
      for (const guestNumber of numbers.slice(1)) {
        const orderNumber = await this.nextOrderNumber(branchId, tx);
        const next = await tx.order.create({
          data: {
            branchId,
            orderNumber,
            type: order.type,
            tableId: order.tableId,
            customerId: order.customerId,
            guestName: order.guestName
              ? `${order.guestName} · guest ${guestNumber}`
              : `Guest ${guestNumber}`,
            notes: `Guest ${guestNumber} from order ${order.orderNumber}`,
            createdById: userId,
            subtotal: 0,
            taxAmount: 0,
            totalAmount: 0,
          },
        });
        const movedIds = groups.get(guestNumber) ?? [];
        await tx.orderItem.updateMany({
          where: { id: { in: movedIds } },
          data: { orderId: next.id },
        });
        await this.reattachKotItems(tx, branchId, movedIds, next.id);
        await this.recomputeTotals(tx, next.id);
        created.push({ id: next.id, orderNumber, guestNumber });
      }
      await this.recomputeTotals(tx, orderId);
    });
    this.realtime.emitToBranch(branchId, 'order.updated', { id: orderId });
    for (const row of created) {
      this.realtime.emitToBranch(branchId, 'order.updated', { id: row.id });
    }
    return { orders: created };
  }

  /** Moves chosen lines onto a new open bill at another free table. */
  async splitToTable(branchId: string, orderId: string, userId: string, dto: SplitTableDto) {
    const order = await this.editableOrder(branchId, orderId);
    if (order.type !== 'DINE_IN' || !order.tableId) {
      throw new BadRequestException('Only a dine-in table bill can be split onto another table');
    }
    const ids = [...new Set(dto.orderItemIds)];
    const moving = order.items.filter((item) => ids.includes(item.id));
    if (moving.length !== ids.length) throw new NotFoundException('One of those lines is not on this bill');
    if (moving.length >= order.items.length) {
      throw new BadRequestException('Leave at least one line on the original table');
    }
    const target = await this.prisma.table.findFirst({
      where: { id: dto.targetTableId, floor: { branchId } },
    });
    if (!target) throw new BadRequestException('Table not found');
    if (target.id === order.tableId) {
      throw new BadRequestException('Choose a different table. Guest split keeps both bills on this table');
    }
    if (target.status === 'OUT_OF_SERVICE') {
      throw new BadRequestException('That table is out of service');
    }
    const occupant = await this.prisma.order.findFirst({
      where: { tableId: target.id, status: 'OPEN' },
      select: { orderNumber: true },
    });
    if (occupant) {
      throw new ConflictException(
        `That table already has open bill #${occupant.orderNumber}`,
      );
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const orderNumber = await this.nextOrderNumber(branchId, tx);
      const next = await tx.order.create({
        data: {
          branchId,
          orderNumber,
          type: 'DINE_IN',
          tableId: target.id,
          customerId: order.customerId,
          guestName: order.guestName,
          partyName: order.partyName ? `${order.partyName} split` : `Split from ${order.orderNumber}`,
          notes: `Split from order ${order.orderNumber}`,
          createdById: userId,
          subtotal: 0,
          taxAmount: 0,
          totalAmount: 0,
        },
      });
      await tx.orderItem.updateMany({
        where: { id: { in: ids } },
        data: { orderId: next.id },
      });
      await this.reattachKotItems(tx, branchId, ids, next.id);
      await this.recomputeTotals(tx, next.id);
      await this.recomputeTotals(tx, order.id);
      await tx.table.update({
        where: { id: target.id },
        data: { status: 'OCCUPIED', statusSince: new Date() },
      });
      return next;
    });
    this.realtime.emitToBranch(branchId, 'order.updated', { id: order.id });
    this.realtime.emitToBranch(branchId, 'order.updated', { id: created.id });
    this.realtime.emitToBranch(branchId, 'table.updated', { id: target.id });
    return { id: created.id, orderNumber: created.orderNumber, tableId: target.id };
  }

  async exchangeItem(
    branchId: string,
    orderId: string,
    userId: string,
    dto: ExchangeItemDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      include: {
        items: true,
        payments: { select: { id: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    const line = order.items.find((item) => item.id === dto.orderItemId);
    if (!line) throw new NotFoundException('Item not found on this order');
    if (order.status === 'CANCELLED' || order.status === 'BILLED') {
      throw new BadRequestException('This order cannot be exchanged');
    }
    if (order.status === 'OPEN') this.assertNoPayments(order);

    const menuItem = await this.prisma.menuItem.findFirst({
      where: { id: dto.menuItemId, branchId, isActive: true },
    });
    if (!menuItem) throw new BadRequestException('Menu item not found');
    const taxMode = await this.getBranchTaxMode(branchId);
    const built = this.buildLine(
      {
        menuItemId: dto.menuItemId,
        quantity: dto.quantity ?? line.quantity,
        modifierIds: [],
        weightKg: dto.weightKg,
        guestNumber: line.guestNumber,
      },
      new Map([[menuItem.id, menuItem]]),
      new Map(),
      taxMode,
      true,
    );
    const replacement = {
      menuItemId: built.menuItem.id,
      nameSnapshot: built.menuItem.name,
      unitPriceSnapshot: built.menuItem.price,
      taxRateSnapshot: built.menuItem.taxRatePercent,
      quantity: built.weightKg ? 1 : built.cartItem.quantity,
      weightKg: built.weightKg,
      lineTotal: built.priced.lineTotal,
      hsnCode: built.hsnCode,
      guestNumber: line.guestNumber,
    };

    if (order.status === 'OPEN') {
      await this.prisma.$transaction(async (tx) => {
        await tx.orderItemModifier.deleteMany({
          where: { orderItemId: line.id },
        });
        await tx.orderItem.update({
          where: { id: line.id },
          data: {
            ...replacement,
            kitchenNote: line.kitchenNote
              ? `${line.kitchenNote} · exchange`
              : 'Exchange',
          },
        });
        await tx.kotItem.updateMany({
          where: { orderItemId: line.id },
          data: { status: 'CANCELLED' },
        });
        await this.recomputeTotals(tx, orderId);
        if (!order.heldAt) {
          await this.generateKots(tx, orderId, branchId, [
            { id: line.id, menuItemId: built.menuItem.id },
          ]);
        }
      });
      this.realtime.emitToBranch(branchId, 'order.updated', { id: orderId });
      return this.getOrder(branchId, orderId);
    }

    if (!order.customerId) {
      throw new BadRequestException(
        'A paid exchange needs a customer so the old line can go back to their wallet',
      );
    }
    const credit = Number(line.lineTotal);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.customer.update({
        where: { id: order.customerId! },
        data: { walletBalance: { increment: credit } },
      });
      const orderNumber = await this.nextOrderNumber(branchId, tx);
      const createdOrder = await tx.order.create({
        data: {
          branchId,
          orderNumber,
          type: 'TAKEAWAY',
          customerId: order.customerId,
          guestName: order.guestName,
          notes: `Exchange from ${order.orderNumber}. ${credit.toFixed(2)} returned to the guest wallet.`,
          createdById: userId,
          subtotal: built.priced.lineTotal,
          taxAmount: built.priced.taxAmount,
          totalAmount: built.priced.lineTotal,
          items: {
            create: {
              ...replacement,
              kitchenNote: `Exchange from ${order.orderNumber}`,
            },
          },
        },
        include: { items: true },
      });
      await this.generateKots(tx, createdOrder.id, branchId, createdOrder.items);
      return createdOrder;
    });
    this.realtime.emitToBranch(branchId, 'order.updated', { id: created.id });
    return {
      credit,
      orderId: created.id,
      orderNumber: created.orderNumber,
    };
  }

  async notifyReceipt(
    restaurantId: string,
    branchId: string,
    orderId: string,
    channel: 'WHATSAPP' | 'SMS',
    phone: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId, status: 'PAID' },
      include: {
        items: true,
        branch: { select: { restaurant: { select: { name: true } } } },
      },
    });
    if (!order) throw new NotFoundException('Paid order not found');
    const lines = order.items.map(
      (item) => `${item.quantity}× ${item.nameSnapshot}  ${item.lineTotal}`,
    );
    const body = [
      order.branch.restaurant.name,
      `Receipt ${order.orderNumber}`,
      ...lines,
      `Total ${order.totalAmount}`,
    ].join('\n');
    return this.messaging.dispatch({
      restaurantId,
      branchId,
      channel,
      purpose: 'RECEIPT',
      to: phone,
      body,
    });
  }

  private async restaurantGates(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        restaurant: {
          select: {
            approvalDiscountAbove: true,
            approvalForVoid: true,
            approvalForRefund: true,
          },
        },
      },
    });
    return branch?.restaurant ?? null;
  }

  private async consumeApproval(
    tx: Prisma.TransactionClient,
    branchId: string,
    orderId: string,
    kind: string,
  ) {
    const row = await tx.approvalRequest.findFirst({
      where: { branchId, orderId, kind, status: 'APPROVED' },
      orderBy: { decidedAt: 'desc' },
    });
    if (!row) {
      throw new BadRequestException(
        `A manager must approve this ${kind.toLowerCase()} on the Approvals page first`,
      );
    }
    await tx.approvalRequest.update({
      where: { id: row.id },
      data: { status: 'CONSUMED' },
    });
  }
}
