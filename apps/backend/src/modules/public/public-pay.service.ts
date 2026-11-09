import {
  BadRequestException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import {
  asBool,
  BranchSettingKey,
  DEFAULT_BRANCH_SETTINGS,
  DEFAULT_RESTAURANT_SETTINGS,
  RestaurantSettingKey,
} from '../settings/setting-keys';
import {
  readBranchSettingsMap,
  readRestaurantSettingsMap,
  restaurantPaymentPrefs,
} from '../settings/settings-kv';

@Injectable()
export class PublicPayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async getBill(token: string) {
    const order = await this.loadByToken(token);
    const paid = order.status === 'PAID';
    const amountPaid = order.payments.reduce(
      (sum, p) => sum + Number(p.amount),
      0,
    );
    const total = Number(order.totalAmount);
    const due = paid ? 0 : Math.max(Math.round((total - amountPaid) * 100) / 100, 0);

    const restaurantMap = await readRestaurantSettingsMap(
      this.prisma,
      order.branch.restaurantId,
    );
    const branchMap = await readBranchSettingsMap(this.prisma, order.branchId);
    const payment = restaurantPaymentPrefs(restaurantMap);
    const paidClaim = asBool(
      branchMap.get(BranchSettingKey.guestPaidClaimEnabled),
      DEFAULT_BRANCH_SETTINGS[BranchSettingKey.guestPaidClaimEnabled] ===
        'true',
    );

    return {
      orderNumber: order.orderNumber,
      status: order.status,
      currency: order.branch.restaurant.currency,
      totalAmount: total,
      tipAmount: Number(order.tipAmount),
      amountPaid,
      due,
      cashLabel:
        payment.cashLabel ||
        DEFAULT_RESTAURANT_SETTINGS[RestaurantSettingKey.cashLabel],
      preferredPaymentMethod: payment.preferred || null,
      paidClaimEnabled: paidClaim,
      upi: order.branch.restaurant.upiVpa
        ? {
            vpa: order.branch.restaurant.upiVpa,
            payeeName:
              order.branch.restaurant.upiPayeeName ||
              order.branch.restaurant.name,
          }
        : null,
      items: order.items.map((item) => ({
        id: item.id,
        name: item.nameSnapshot,
        quantity: item.quantity,
        lineTotal: Number(item.lineTotal),
      })),
    };
  }

  async claimPaid(token: string) {
    const order = await this.loadByToken(token);
    if (order.status === 'PAID') {
      return { ok: true, alreadyPaid: true };
    }
    if (order.status !== 'OPEN') {
      throw new BadRequestException('This bill cannot accept a paid claim');
    }

    const branchMap = await readBranchSettingsMap(this.prisma, order.branchId);
    const paidClaim = asBool(
      branchMap.get(BranchSettingKey.guestPaidClaimEnabled),
      DEFAULT_BRANCH_SETTINGS[BranchSettingKey.guestPaidClaimEnabled] ===
        'true',
    );
    if (!paidClaim) {
      throw new BadRequestException(
        'This restaurant has not turned on guest “I paid” for bill links',
      );
    }

    this.realtime.emitToBranch(order.branchId, 'order.paid_claim', {
      orderId: order.id,
      orderNumber: order.orderNumber,
    });

    const title = `Order #${order.orderNumber} — guest says they paid`;
    const body =
      'Confirm UPI on the till — the guest did not settle the bank from this link';
    try {
      await this.notifications.notifyByPermission(order.branchId, 'bills.print', {
        type: 'order.paid_claim',
        title,
        body,
        entity: 'Order',
        entityId: order.id,
      });
      await this.notifications.notifyByPermission(
        order.branchId,
        'tables.manage',
        {
          type: 'order.paid_claim',
          title,
          body,
          entity: 'Order',
          entityId: order.id,
        },
      );
    } catch {
      // Best-effort: realtime already fired.
    }

    return { ok: true, alreadyPaid: false };
  }

  private async loadByToken(token: string) {
    const trimmed = token.trim();
    if (!trimmed || trimmed.length < 16) {
      throw new NotFoundException('Pay link not found');
    }
    const order = await this.prisma.order.findFirst({
      where: { payToken: trimmed },
      include: {
        items: { orderBy: { id: 'asc' } },
        payments: true,
        branch: {
          include: {
            restaurant: {
              select: {
                id: true,
                name: true,
                currency: true,
                upiVpa: true,
                upiPayeeName: true,
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Pay link not found');
    if (
      order.payTokenExpiresAt &&
      order.payTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new GoneException('This pay link has expired');
    }
    if (order.status === 'CANCELLED') {
      throw new GoneException('This bill was cancelled');
    }
    return order;
  }
}
