import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CampaignDto,
  CouponDto,
  PromotionDto,
} from '@nodedr-restaurant/types';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { localMinuteAndDay } from '../../common/time';
import { PrismaService } from '../../prisma/prisma.service';
import { openSecret } from '../../auth/totp';
import { fetchWeatherText } from '../inventory/ai-chat';
import { descendantIds } from '../menu/menu-rules';
import { EmailService } from '../email/email.service';
import { MessagingService } from '../messaging/messaging.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import {
  discountAmount,
  evaluateCoupon,
  fromMinutes,
  promotionActive,
  promotionBlocked,
  round2,
  toMinutes,
} from './discounts';

export interface CheckoutDiscount {
  amount: number;
  couponId?: string;
  couponCode?: string;
  promotionName?: string;
}

const asDate = (s?: string) => (s ? new Date(s) : null);

@Injectable()
export class MarketingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: BranchTimeService,
    private readonly email: EmailService,
    private readonly webhooks: WebhooksService,
    private readonly messaging: MessagingService,
  ) {}

  // --- Coupons -------------------------------------------------------------

  listCoupons(branchId: string) {
    return this.prisma.coupon.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createCoupon(branchId: string, dto: CouponDto) {
    const code = dto.code.toUpperCase();
    const clash = await this.prisma.coupon.findUnique({
      where: { branchId_code: { branchId, code } },
    });
    if (clash) throw new BadRequestException('That coupon code already exists');
    return this.prisma.coupon.create({
      data: {
        branchId,
        code,
        kind: dto.kind,
        value: dto.value,
        minOrderAmount: dto.minOrderAmount,
        maxDiscount: dto.maxDiscount,
        validFrom: asDate(dto.validFrom),
        validUntil: asDate(dto.validUntil),
        usageLimit: dto.usageLimit,
        isActive: dto.isActive,
      },
    });
  }

  async setCouponActive(branchId: string, id: string, isActive: boolean) {
    await this.getCoupon(branchId, id);
    return this.prisma.coupon.update({ where: { id }, data: { isActive } });
  }

  async deleteCoupon(branchId: string, id: string) {
    await this.getCoupon(branchId, id);
    await this.prisma.coupon.delete({ where: { id } });
    return { ok: true };
  }

  private async getCoupon(branchId: string, id: string) {
    const c = await this.prisma.coupon.findFirst({ where: { id, branchId } });
    if (!c) throw new NotFoundException('Coupon not found');
    return c;
  }

  // --- Promotions (happy hour) --------------------------------------------

  async listPromotions(branchId: string) {
    const rows = await this.prisma.promotion.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((p) => ({
      ...p,
      startTime: fromMinutes(p.startMinute),
      endTime: fromMinutes(p.endMinute),
    }));
  }

  createPromotion(branchId: string, dto: PromotionDto) {
    return this.prisma.promotion.create({
      data: {
        branchId,
        name: dto.name,
        kind: dto.kind,
        value: dto.kind === 'BOGO' ? 0 : dto.value,
        buyQuantity: dto.buyQuantity,
        getQuantity: dto.getQuantity,
        audience: dto.audience ?? 'ALL',
        categoryId: dto.categoryId ?? null,
        minOrderAmount: dto.minOrderAmount ?? 0,
        customerId: dto.customerId || null,
        weatherCode: dto.weatherCode?.trim() || null,
        bundleMenuItemId: dto.bundleMenuItemId || null,
        allDay: dto.allDay ?? false,
        daysOfWeek: [...new Set(dto.daysOfWeek)].sort(),
        startMinute: toMinutes(dto.startTime),
        endMinute: toMinutes(dto.endTime),
        isActive: dto.isActive,
      },
    });
  }

  private bogoAmount(
    lines: { lineTotal: number; quantity: number }[],
    buy: number,
    get: number,
  ) {
    const units: number[] = [];
    for (const line of lines) {
      const each = line.quantity > 0 ? line.lineTotal / line.quantity : 0;
      for (let i = 0; i < line.quantity; i++) units.push(each);
    }
    units.sort((a, b) => b - a);
    const group = Math.max(buy + get, 1);
    let free = 0;
    for (let i = 0; i < units.length; i += group) {
      const slice = units.slice(i, i + group);
      const paid = slice.slice(0, buy);
      const bonus = slice.slice(buy, buy + get);
      void paid;
      free += bonus.reduce((sum, n) => sum + n, 0);
    }
    return round2(free);
  }

  async setPromotionActive(branchId: string, id: string, isActive: boolean) {
    const p = await this.prisma.promotion.findFirst({
      where: { id, branchId },
    });
    if (!p) throw new NotFoundException('Promotion not found');
    return this.prisma.promotion.update({ where: { id }, data: { isActive } });
  }

  async deletePromotion(branchId: string, id: string) {
    const p = await this.prisma.promotion.findFirst({
      where: { id, branchId },
    });
    if (!p) throw new NotFoundException('Promotion not found');
    await this.prisma.promotion.delete({ where: { id } });
    return { ok: true };
  }

  // --- Checkout integration -----------------------------------------------

  /**
   * The automatic discount for a bill: the better of a valid coupon and any
   * active happy-hour promotion (they do not stack). A bad coupon code is an
   * error the cashier should see, not something to silently ignore.
   */
  async resolveCheckoutDiscount(
    branchId: string,
    subtotal: number,
    couponCode: string | undefined,
    now = new Date(),
    extras?: {
      lines?: { lineTotal: number; quantity: number; menuItemId?: string }[];
      employeeDiscount?: boolean;
      employeePercent?: number;
      customerId?: string | null;
    },
  ): Promise<CheckoutDiscount> {
    let best: CheckoutDiscount = { amount: 0 };

    const tz = await this.time.tzForBranch(branchId);
    const { day, minute } = localMinuteAndDay(now, tz);
    const promos = await this.prisma.promotion.findMany({
      where: { branchId, isActive: true },
    });
    let weatherText: string | null = null;
    if (promos.some((promo) => promo.weatherCode)) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: {
          restaurant: { select: { weatherBaseUrl: true, weatherApiKeySealed: true } },
        },
      });
      const url = branch?.restaurant.weatherBaseUrl?.trim();
      if (url) {
        try {
          const sealed = branch?.restaurant.weatherApiKeySealed;
          weatherText = await fetchWeatherText(
            url,
            sealed
              ? openSecret(sealed, process.env.WEBHOOK_KEY || process.env.JWT_SECRET || '')
              : null,
          );
        } catch {
          weatherText = null;
        }
      }
    }
    const categories = promos.some((p) => p.categoryId)
      ? await this.prisma.menuCategory.findMany({
          where: { branchId },
          select: { id: true, parentId: true },
        })
      : [];
    const lineItemIds = [
      ...new Set(
        (extras?.lines ?? [])
          .map((line) => line.menuItemId)
          .filter((id): id is string => !!id),
      ),
    ];
    const lineItems =
      lineItemIds.length > 0
        ? await this.prisma.menuItem.findMany({
            where: { id: { in: lineItemIds } },
            select: { id: true, categoryId: true },
          })
        : [];
    const categoryByItem = new Map(
      lineItems.map((item) => [item.id, item.categoryId]),
    );
    for (const p of promos) {
      if (p.audience === 'STAFF' && !extras?.employeeDiscount) continue;
      if (!promotionActive({ ...p, value: Number(p.value) }, day, minute, p.allDay))
        continue;
      let scopedLines = extras?.lines ?? [];
      let scopedSubtotal = subtotal;
      if (p.categoryId) {
        const allowed = descendantIds(categories, p.categoryId);
        scopedLines = scopedLines.filter((line) =>
          allowed.has(categoryByItem.get(line.menuItemId ?? '') ?? ''),
        );
        scopedSubtotal = round2(
          scopedLines.reduce((sum, line) => sum + line.lineTotal, 0),
        );
      }
      if (
        promotionBlocked({
          minOrderAmount: Number(p.minOrderAmount),
          scopedSubtotal,
          ruleCustomerId: p.customerId,
          billCustomerId: extras?.customerId ?? null,
          weatherCode: p.weatherCode,
          weatherText,
          bundleMenuItemId: p.bundleMenuItemId,
          lineMenuItemIds: lineItemIds,
        })
      ) {
        continue;
      }
      let amount = 0;
      if (p.kind === 'BOGO') {
        amount = this.bogoAmount(
          scopedLines,
          p.buyQuantity ?? 1,
          p.getQuantity ?? 1,
        );
      } else {
        amount = discountAmount(p.kind, Number(p.value), scopedSubtotal);
      }
      if (amount > best.amount) best = { amount, promotionName: p.name };
    }
    if (extras?.employeeDiscount && (extras.employeePercent ?? 0) > 0) {
      const amount = discountAmount('PERCENT', extras.employeePercent ?? 0, subtotal);
      if (amount > best.amount) {
        best = { amount, promotionName: 'Employee discount' };
      }
    }

    if (couponCode) {
      const coupon = await this.prisma.coupon.findUnique({
        where: {
          branchId_code: { branchId, code: couponCode.trim().toUpperCase() },
        },
      });
      if (!coupon)
        throw new BadRequestException('That coupon code is not valid');
      if (coupon.kind !== 'PERCENT' && coupon.kind !== 'FLAT') {
        throw new BadRequestException('That coupon code is not valid');
      }
      const result = evaluateCoupon(
        {
          kind: coupon.kind,
          value: Number(coupon.value),
          minOrderAmount: Number(coupon.minOrderAmount),
          maxDiscount:
            coupon.maxDiscount == null ? null : Number(coupon.maxDiscount),
          validFrom: coupon.validFrom,
          validUntil: coupon.validUntil,
          usageLimit: coupon.usageLimit,
          usedCount: coupon.usedCount,
          isActive: coupon.isActive,
        },
        subtotal,
        now,
      );
      if (!result.ok) throw new BadRequestException(result.reason);
      if (result.amount >= best.amount) {
        best = {
          amount: result.amount,
          couponId: coupon.id,
          couponCode: coupon.code,
        };
      }
    }
    return { ...best, amount: round2(best.amount) };
  }

  /** Counts one use, atomically refusing once the limit is reached. */
  async redeemCoupon(tx: Prisma.TransactionClient, couponId: string) {
    const updated = await tx.$executeRaw`
      UPDATE "coupons" SET "usedCount" = "usedCount" + 1
      WHERE "id" = ${couponId}
        AND "isActive" = true
        AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
    if (updated === 0)
      throw new ConflictException('This coupon has just been fully used');
  }

  // --- Campaigns -----------------------------------------------------------

  listCampaigns(branchId: string) {
    return this.prisma.campaign.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
    });
  }

  createCampaign(branchId: string, dto: CampaignDto) {
    if (dto.segment === 'TIER' && !dto.tierId) {
      throw new BadRequestException('Pick a membership tier for this audience');
    }
    if (dto.segment === 'RFM' && !dto.rfmLabel) {
      throw new BadRequestException('Pick an RFM label for this audience');
    }
    return this.prisma.campaign.create({
      data: {
        branchId,
        name: dto.name,
        channel: dto.channel,
        segment: dto.segment,
        tierId: dto.segment === 'TIER' ? dto.tierId : null,
        rfmLabel: dto.segment === 'RFM' ? dto.rfmLabel : null,
        message: dto.message,
      },
    });
  }

  async deleteCampaign(branchId: string, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, branchId } });
    if (!c) throw new NotFoundException('Campaign not found');
    await this.prisma.campaign.delete({ where: { id } });
    return { ok: true };
  }

  /** Customers a campaign would reach, with the contact detail its channel needs. */
  async audience(branchId: string, campaignId: string) {
    const c = await this.prisma.campaign.findFirst({
      where: { id: campaignId, branchId },
    });
    if (!c) throw new NotFoundException('Campaign not found');
    const tz = await this.time.tzForBranch(branchId);
    const customers = await this.prisma.customer.findMany({
      where: {
        branchId,
        marketingOptOut: false,
        ...(c.channel === 'EMAIL'
          ? { email: { not: null } }
          : { phone: { not: null } }),
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        birthday: true,
        tierId: true,
        rfmSegment: true,
        orders: {
          where: { status: 'PAID' },
          select: { billedAt: true },
          orderBy: { billedAt: 'desc' },
        },
      },
    });
    const now = new Date();
    const month = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        month: 'numeric',
      }).format(now),
    );
    const cutoff = now.getTime() - 60 * 86_400_000;
    const picked = customers.filter((cu) => {
      if (c.segment === 'ALL') return true;
      if (c.segment === 'LOYAL') return cu.orders.length >= 5;
      if (c.segment === 'LAPSED') {
        const last = cu.orders[0]?.billedAt?.getTime();
        return last != null && last < cutoff;
      }
      if (c.segment === 'TIER') return cu.tierId === c.tierId;
      if (c.segment === 'RFM') return cu.rfmSegment === c.rfmLabel;
      return cu.birthday != null && cu.birthday.getUTCMonth() + 1 === month;
    });
    return {
      campaign: c,
      recipients: picked.map((cu) => ({
        name: cu.name ?? '',
        contact: (c.channel === 'EMAIL' ? cu.email : cu.phone) ?? '',
      })),
    };
  }

  /**
   * Sends a campaign. Email goes out through the operator's SMTP server. SMS
   * and WhatsApp need a provider, so each message is handed to the
   * restaurant's webhook (`campaign.message`) for an automation service to
   * deliver. A campaign can be sent once an hour, so a double-click or a
   * retry loop cannot spam customers.
   */
  async send(branchId: string, campaignId: string) {
    const { campaign, recipients } = await this.audience(branchId, campaignId);
    if (
      campaign.lastSentAt &&
      Date.now() - campaign.lastSentAt.getTime() < 3600_000
    )
      throw new BadRequestException(
        'This campaign was sent less than an hour ago',
      );
    if (recipients.length === 0)
      throw new BadRequestException('No customers match this campaign yet');
    if (recipients.length > 500)
      throw new BadRequestException(
        'A campaign can reach at most 500 customers at once — narrow the audience',
      );

    // Reserve the send slot first (atomic), so two simultaneous clicks
    // cannot both pass the check above and send twice.
    const reserved = await this.prisma.campaign.updateMany({
      where: {
        id: campaign.id,
        OR: [
          { lastSentAt: null },
          { lastSentAt: { lt: new Date(Date.now() - 3600_000) } },
        ],
      },
      data: { lastSentAt: new Date(), lastSentCount: 0 },
    });
    if (reserved.count === 0)
      throw new BadRequestException('This campaign is already being sent');

    let result: { sent: number; failed: number };
    if (campaign.channel === 'EMAIL') {
      if (!this.email.isConfigured())
        throw await this.releaseAndFail(
          campaign.id,
          'Email is not set up on this server (SMTP_URL / SMTP_FROM)',
        );
      const restaurant = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { restaurant: { select: { name: true } } },
      });
      const footer = `\n\n—\nYou are receiving this because you are a customer of ${restaurant?.restaurant.name ?? 'our restaurant'}. Reply to this email to stop receiving offers.`;
      result = await this.email.sendEach(
        recipients.map((r) => ({
          to: r.contact,
          subject: campaign.name,
          text: campaign.message + footer,
        })),
      );
    } else {
      const restaurant = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { restaurantId: true },
      });
      const channel = campaign.channel === 'SMS' ? 'SMS' : 'WHATSAPP';
      const ready = restaurant
        ? await this.messaging.isChannelReady(restaurant.restaurantId, channel)
        : false;
      const hasHook = await this.webhooks.hasSubscriber(
        branchId,
        'campaign.message',
      );
      if (!ready && !hasHook)
        throw await this.releaseAndFail(
          campaign.id,
          `Sending ${campaign.channel === 'SMS' ? 'SMS' : 'WhatsApp'} needs a provider in Operations or a webhook subscribed to "campaign.message"`,
        );
      result = { sent: 0, failed: 0 };
      if (ready && restaurant) {
        for (const r of recipients) {
          const out = await this.messaging.dispatch({
            restaurantId: restaurant.restaurantId,
            branchId,
            channel,
            purpose: 'CAMPAIGN',
            to: r.contact,
            body: campaign.message,
          });
          if (out?.status === 'SENT') result.sent += 1;
          else result.failed += 1;
        }
      }
      if (hasHook) {
        for (const r of recipients) {
          await this.webhooks.emitForBranch(branchId, 'campaign.message', {
            campaignId: campaign.id,
            channel: campaign.channel,
            to: r.contact,
            name: r.name,
            message: campaign.message,
          });
        }
        if (!ready) result = { sent: recipients.length, failed: 0 };
      }
    }
    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { lastSentCount: result.sent },
    });
    return result;
  }

  private async releaseAndFail(campaignId: string, message: string) {
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { lastSentAt: null, lastSentCount: null },
    });
    return new BadRequestException(message);
  }
}
