import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomInt } from 'crypto';
import type {
  CustomerDto,
  EmployeeDiscountPolicyDto,
  LoyaltyRuleDto,
  MembershipTierDto,
  RewardDto,
  RfmLabelDto,
} from '@nodedr-restaurant/types';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { hashEmail, openCustomerFields, sealCustomerFields } from './field-seal';
import { favoriteProducts, visitMetrics } from './loyalty';
import { recommendDishes } from './recommend';
import { consumePointLots, dropExpiredPoints } from './loyalty-ledger';
import {
  assignQuintiles,
  estimateClv,
  matchRfmLabel,
  recencyDays,
  rfmScoreString,
} from './rfm';

const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private sealKey() {
    return this.config.get<string>('WEBHOOK_KEY') ?? this.config.get<string>('JWT_SECRET') ?? '';
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async expireLoyaltyPoints() {
    const rows = await this.prisma.pointLot.findMany({
      where: { pointsRemaining: { gt: 0 }, expiresAt: { lt: new Date() } },
      select: { customerId: true },
      distinct: ['customerId'],
    });
    for (const row of rows) {
      try {
        await this.prisma.$transaction((tx) => dropExpiredPoints(tx, row.customerId));
      } catch (err) {
        this.logger.warn(
          `Point expiry ${row.customerId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async refreshAllRfm() {
    const branches = await this.prisma.branch.findMany({ select: { id: true } });
    for (const branch of branches) {
      try {
        await this.recomputeRfm(branch.id);
      } catch (err) {
        this.logger.warn(
          `RFM refresh ${branch.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async list(branchId: string, search?: string) {
    const emailLookup = search?.includes('@') ? hashEmail(search) : undefined;
    const rows = await this.prisma.customer.findMany({
      where: {
        branchId,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search } },
                { email: { contains: search, mode: 'insensitive' } },
                ...(emailLookup ? [{ emailLookup }] : []),
              ],
            }
          : {}),
      },
      include: { tier: { select: { id: true, name: true, earnMultiplier: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => openCustomerFields(row, this.sealKey()));
  }

  async getById(branchId: string, id: string) {
    await this.prisma.$transaction((tx) => dropExpiredPoints(tx, id));
    const customer = await this.prisma.customer.findFirst({
      where: { id, branchId },
      include: {
        orders: {
          where: { status: 'PAID' },
          orderBy: { billedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            orderNumber: true,
            totalAmount: true,
            billedAt: true,
          },
        },
        giftCards: true,
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    const [lines, paid, rewards] = await Promise.all([
      this.prisma.orderItem.findMany({
        where: { order: { customerId: id, branchId, status: 'PAID' } },
        select: { orderId: true, quantity: true, menuItem: { select: { id: true, name: true } } },
      }),
      this.prisma.order.findMany({
        where: { customerId: id, branchId, status: 'PAID' },
        select: { totalAmount: true, billedAt: true },
      }),
      this.prisma.reward.findMany({
        where: { branchId, isActive: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      ...openCustomerFields(customer, this.sealKey()),
      favorites: favoriteProducts(
        lines.map((line) => ({
          menuItemId: line.menuItem.id,
          name: line.menuItem.name,
          quantity: line.quantity,
        })),
      ),
      recommendations: recommendDishes(
        lines.map((line) => ({
          orderId: line.orderId,
          menuItemId: line.menuItem.id,
          name: line.menuItem.name,
          quantity: line.quantity,
        })),
      ),
      metrics: visitMetrics(
        paid.map((order) => ({
          total: Number(order.totalAmount),
          at: order.billedAt,
        })),
      ),
      rewards,
    };
  }

  async analytics(branchId: string) {
    const customers = await this.prisma.customer.findMany({
      where: { branchId },
      select: {
        id: true,
        name: true,
        phone: true,
        orders: {
          where: { status: 'PAID' },
          select: { totalAmount: true, billedAt: true },
        },
      },
    });
    return customers
      .map((customer) => ({
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        ...visitMetrics(
          customer.orders.map((order) => ({
            total: Number(order.totalAmount),
            at: order.billedAt,
          })),
        ),
      }))
      .sort((a, b) => b.spend - a.spend || a.name?.localeCompare(b.name ?? '') || 0);
  }

  async loyaltyRule(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        restaurant: {
          select: { loyaltyEarnPerCurrency: true, loyaltyPointValue: true },
        },
      },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    const [rule, menuItems] = await Promise.all([
      this.prisma.loyaltyRule.findUnique({ where: { branchId } }),
      this.prisma.menuItem.findMany({
        where: { branchId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      rule,
      defaults: {
        earnPerCurrency: branch.restaurant.loyaltyEarnPerCurrency,
        pointValue: branch.restaurant.loyaltyPointValue,
      },
      menuItems,
    };
  }

  async saveLoyaltyRule(branchId: string, dto: LoyaltyRuleDto) {
    const ids = dto.eligibleMenuItemIds ?? [];
    if (ids.length > 0) {
      const found = await this.prisma.menuItem.count({
        where: { branchId, id: { in: ids } },
      });
      if (found !== ids.length) {
        throw new BadRequestException('One of those dishes is not on this branch');
      }
    }
    const data = {
      earnPerCurrency: dto.earnPerCurrency ?? null,
      pointValue: dto.pointValue ?? null,
      maxEarnPerOrder: dto.maxEarnPerOrder ?? null,
      maxRedeemPerOrder: dto.maxRedeemPerOrder ?? null,
      expiryDays: dto.expiryDays ?? null,
      eligibleMenuItemIds: ids,
      cashbackPercent: dto.cashbackPercent ?? 0,
      cashbackCap: dto.cashbackCap ?? null,
    };
    return this.prisma.loyaltyRule.upsert({
      where: { branchId },
      create: { branchId, ...data },
      update: data,
    });
  }

  async listRewards(branchId: string) {
    return this.prisma.reward.findMany({
      where: { branchId },
      orderBy: { name: 'asc' },
    });
  }

  async createReward(branchId: string, dto: RewardDto) {
    return this.prisma.reward.create({
      data: {
        branchId,
        name: dto.name,
        pointsCost: dto.pointsCost ?? 0,
        cashbackCost: dto.cashbackCost ?? 0,
      },
    });
  }

  async removeReward(branchId: string, id: string) {
    const reward = await this.prisma.reward.findFirst({ where: { id, branchId } });
    if (!reward) throw new NotFoundException('Reward not found');
    await this.prisma.reward.delete({ where: { id } });
    return { ok: true };
  }

  async redeemReward(branchId: string, customerId: string, rewardId: string) {
    await this.assertInBranch(branchId, customerId);
    return this.prisma.$transaction(async (tx) => {
      await dropExpiredPoints(tx, customerId);
      const reward = await tx.reward.findFirst({
        where: { id: rewardId, branchId, isActive: true },
      });
      if (!reward) throw new NotFoundException('Reward not found');
      const pointsCost = reward.pointsCost;
      const cashbackCost = Number(reward.cashbackCost);
      if (pointsCost <= 0 && cashbackCost <= 0) {
        throw new BadRequestException('This reward has no cost');
      }
      const guest = await tx.customer.findFirst({
        where: { id: customerId, branchId },
      });
      if (!guest) throw new NotFoundException('Customer not found');
      if (guest.loyaltyPoints < pointsCost) {
        throw new BadRequestException(
          `Customer only has ${guest.loyaltyPoints} loyalty points`,
        );
      }
      if (Number(guest.cashbackBalance) < cashbackCost) {
        throw new BadRequestException('Customer cashback balance is too low');
      }
      if (pointsCost > 0) {
        const spent = await tx.customer.updateMany({
          where: { id: customerId, loyaltyPoints: { gte: pointsCost } },
          data: { loyaltyPoints: { decrement: pointsCost } },
        });
        if (spent.count === 0) {
          throw new BadRequestException('Customer loyalty balance changed — please retry');
        }
        await consumePointLots(tx, customerId, pointsCost);
      }
      if (cashbackCost > 0) {
        const spent = await tx.customer.updateMany({
          where: { id: customerId, cashbackBalance: { gte: cashbackCost } },
          data: { cashbackBalance: { decrement: cashbackCost } },
        });
        if (spent.count === 0) {
          throw new BadRequestException('Customer cashback balance changed — please retry');
        }
      }
      return tx.rewardRedemption.create({
        data: { rewardId, customerId },
      });
    });
  }

  async employeeDiscounts(branchId: string) {
    const restaurantId = await this.restaurantId(branchId);
    const [policies, staff, roles] = await Promise.all([
      this.prisma.employeeDiscount.findMany({
        where: { branchId },
        include: {
          user: { select: { id: true, name: true } },
          role: { select: { id: true, label: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.findMany({
        where: { restaurantId, isActive: true },
        select: { id: true, name: true, role: { select: { label: true } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.role.findMany({
        where: { restaurantId },
        select: { id: true, label: true },
        orderBy: { label: 'asc' },
      }),
    ]);
    return { policies, staff, roles };
  }

  async createEmployeeDiscount(branchId: string, dto: EmployeeDiscountPolicyDto) {
    const restaurantId = await this.restaurantId(branchId);
    if (dto.userId) {
      const user = await this.prisma.user.findFirst({
        where: { id: dto.userId, restaurantId },
      });
      if (!user) throw new BadRequestException('Staff member not found');
      const existing = await this.prisma.employeeDiscount.findFirst({
        where: { branchId, userId: dto.userId },
      });
      if (existing) {
        throw new BadRequestException('That staff member already has a discount');
      }
    }
    if (dto.roleId) {
      const role = await this.prisma.role.findFirst({
        where: { id: dto.roleId, restaurantId },
      });
      if (!role) throw new BadRequestException('Role not found');
      const existing = await this.prisma.employeeDiscount.findFirst({
        where: { branchId, roleId: dto.roleId, userId: null },
      });
      if (existing) throw new BadRequestException('That role already has a discount');
    }
    return this.prisma.employeeDiscount.create({
      data: {
        branchId,
        userId: dto.userId ?? null,
        roleId: dto.userId ? null : (dto.roleId ?? null),
        percent: dto.percent,
        maxAmount: dto.maxAmount ?? null,
      },
    });
  }

  async removeEmployeeDiscount(branchId: string, id: string) {
    const row = await this.prisma.employeeDiscount.findFirst({ where: { id, branchId } });
    if (!row) throw new NotFoundException('Staff discount not found');
    await this.prisma.employeeDiscount.delete({ where: { id } });
    return { ok: true };
  }

  async create(branchId: string, dto: CustomerDto) {
    const data = await this.customerData(branchId, dto);
    const row = await this.prisma.customer.create({ data: { ...data, branchId } });
    return openCustomerFields(row, this.sealKey());
  }

  async update(branchId: string, id: string, dto: Partial<CustomerDto>) {
    await this.assertInBranch(branchId, id);
    const data = await this.customerData(branchId, dto, id);
    const row = await this.prisma.customer.update({ where: { id }, data });
    return openCustomerFields(row, this.sealKey());
  }

  // Hard delete — Order.customerId and GiftCard.customerId are both
  // optional with onDelete: SetNull (schema.prisma), so this never orphans
  // or blocks on past orders/gift cards; it just detaches them from the
  // profile being removed.
  async remove(branchId: string, id: string) {
    await this.assertInBranch(branchId, id);
    await this.prisma.customer.delete({ where: { id } });
    return { ok: true };
  }

  async listTiers(branchId: string) {
    const restaurantId = await this.restaurantId(branchId);
    return this.prisma.membershipTier.findMany({
      where: { restaurantId },
      orderBy: [{ minPoints: 'asc' }, { name: 'asc' }],
    });
  }

  async createTier(branchId: string, dto: MembershipTierDto) {
    const restaurantId = await this.restaurantId(branchId);
    return this.prisma.membershipTier.create({
      data: {
        restaurantId,
        name: dto.name,
        minPoints: dto.minPoints,
        earnMultiplier: dto.earnMultiplier ?? 1,
      },
    });
  }

  async removeTier(branchId: string, id: string) {
    const restaurantId = await this.restaurantId(branchId);
    const tier = await this.prisma.membershipTier.findFirst({
      where: { id, restaurantId },
    });
    if (!tier) throw new NotFoundException('Membership tier not found');
    await this.prisma.membershipTier.delete({ where: { id } });
    return { ok: true };
  }

  async segments(branchId: string) {
    const tz = (
      await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { restaurant: { select: { timezone: true } } },
      })
    )?.restaurant.timezone ?? 'Asia/Kolkata';
    const month = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'numeric' }).format(
        new Date(),
      ),
    );
    const cutoff = new Date(Date.now() - 60 * 86_400_000);
    const customers = await this.prisma.customer.findMany({
      where: { branchId },
      select: {
        birthday: true,
        tierId: true,
        rfmSegment: true,
        orders: {
          where: { status: 'PAID' },
          select: { billedAt: true },
          orderBy: { billedAt: 'desc' },
          take: 1,
        },
        _count: { select: { orders: { where: { status: 'PAID' } } } },
      },
    });
    const tiers = await this.listTiers(branchId);
    const counts = {
      all: customers.length,
      loyal: customers.filter((row) => row._count.orders >= 5).length,
      lapsed: customers.filter((row) => {
        const last = row.orders[0]?.billedAt;
        return last != null && last < cutoff;
      }).length,
      birthdayMonth: customers.filter(
        (row) => row.birthday != null && row.birthday.getUTCMonth() + 1 === month,
      ).length,
      tiers: tiers.map((tier) => ({
        id: tier.id,
        name: tier.name,
        minPoints: tier.minPoints,
        earnMultiplier: Number(tier.earnMultiplier),
        count: customers.filter((row) => row.tierId === tier.id).length,
      })),
      rfm: (
        await this.prisma.rfmLabel.findMany({
          where: { restaurantId: await this.restaurantId(branchId) },
          orderBy: { sortOrder: 'asc' },
        })
      ).map((label) => ({
        name: label.name,
        count: customers.filter((row) => row.rfmSegment === label.name).length,
      })),
    };
    return counts;
  }

  async listRfmLabels(branchId: string) {
    const restaurantId = await this.restaurantId(branchId);
    return this.prisma.rfmLabel.findMany({
      where: { restaurantId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createRfmLabel(branchId: string, dto: RfmLabelDto) {
    const restaurantId = await this.restaurantId(branchId);
    return this.prisma.rfmLabel.create({
      data: {
        restaurantId,
        name: dto.name,
        minR: dto.minR,
        maxR: dto.maxR,
        minF: dto.minF,
        maxF: dto.maxF,
        minM: dto.minM,
        maxM: dto.maxM,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updateRfmLabel(branchId: string, id: string, dto: RfmLabelDto) {
    const restaurantId = await this.restaurantId(branchId);
    const existing = await this.prisma.rfmLabel.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) throw new NotFoundException('RFM label not found');
    return this.prisma.rfmLabel.update({
      where: { id },
      data: {
        name: dto.name,
        minR: dto.minR,
        maxR: dto.maxR,
        minF: dto.minF,
        maxF: dto.maxF,
        minM: dto.minM,
        maxM: dto.maxM,
        sortOrder: dto.sortOrder ?? existing.sortOrder,
      },
    });
  }

  async removeRfmLabel(branchId: string, id: string) {
    const restaurantId = await this.restaurantId(branchId);
    const existing = await this.prisma.rfmLabel.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) throw new NotFoundException('RFM label not found');
    await this.prisma.rfmLabel.delete({ where: { id } });
    return { ok: true };
  }

  async recomputeRfm(branchId: string) {
    const restaurantId = await this.restaurantId(branchId);
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        clvHorizonMonths: true,
        clvMarginPercent: true,
        rfmLabels: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    const customers = await this.prisma.customer.findMany({
      where: { branchId },
      select: {
        id: true,
        orders: {
          where: { status: 'PAID' },
          select: { billedAt: true, totalAmount: true },
        },
      },
    });
    const now = new Date();
    const scored = customers
      .map((row) => {
        const paid = row.orders.filter((order) => order.billedAt);
        const dates = paid
          .map((order) => order.billedAt!)
          .sort((a, b) => a.getTime() - b.getTime());
        return {
          id: row.id,
          orderCount: paid.length,
          spend: paid.reduce((sum, order) => sum + Number(order.totalAmount), 0),
          firstPaidAt: dates[0] ?? null,
          lastPaidAt: dates[dates.length - 1] ?? null,
        };
      })
      .filter((row) => row.orderCount > 0 && row.lastPaidAt && row.firstPaidAt);
    const R = assignQuintiles(
      scored.map((row) => recencyDays(row.lastPaidAt!, now)),
      true,
    );
    const F = assignQuintiles(
      scored.map((row) => row.orderCount),
      false,
    );
    const M = assignQuintiles(
      scored.map((row) => row.spend),
      false,
    );
    await this.prisma.$transaction(
      customers.map((row) => {
        const idx = scored.findIndex((item) => item.id === row.id);
        if (idx < 0) {
          return this.prisma.customer.update({
            where: { id: row.id },
            data: {
              rfmRecency: null,
              rfmFrequency: null,
              rfmMonetary: null,
              rfmScore: null,
              rfmSegment: null,
              clvEstimate: 0,
              rfmComputedAt: now,
            },
          });
        }
        const r = R[idx];
        const f = F[idx];
        const m = M[idx];
        const agg = scored[idx];
        return this.prisma.customer.update({
          where: { id: row.id },
          data: {
            rfmRecency: r,
            rfmFrequency: f,
            rfmMonetary: m,
            rfmScore: rfmScoreString(r, f, m),
            rfmSegment: matchRfmLabel(r, f, m, restaurant.rfmLabels),
            clvEstimate: estimateClv({
              orderCount: agg.orderCount,
              totalSpend: agg.spend,
              firstPaidAt: agg.firstPaidAt!,
              lastPaidAt: agg.lastPaidAt!,
              now,
              horizonMonths: restaurant.clvHorizonMonths,
              marginPercent: Number(restaurant.clvMarginPercent),
            }),
            rfmComputedAt: now,
          },
        });
      }),
    );
    return this.segments(branchId);
  }

  private async customerData(
    branchId: string,
    dto: Partial<CustomerDto>,
    exceptId?: string,
  ) {
    const { referredByCode, referralCode, ...rest } = dto;
    let referredById: string | undefined;
    if (referredByCode) {
      const referrer = await this.prisma.customer.findFirst({
        where: { branchId, referralCode: referredByCode },
      });
      if (!referrer || referrer.id === exceptId) {
        throw new BadRequestException('Referral code was not found');
      }
      referredById = referrer.id;
    }
    const code =
      referralCode?.trim() ||
      (exceptId ? undefined : await this.uniqueReferralCode());
    const sealed = sealCustomerFields(rest, this.sealKey());
    return {
      ...sealed,
      ...(referredById ? { referredById } : {}),
      ...(code ? { referralCode: code } : {}),
    };
  }

  private async uniqueReferralCode() {
    for (let attempt = 0; attempt < 8; attempt++) {
      let code = '';
      for (let i = 0; i < 8; i++) {
        code += REFERRAL_ALPHABET[randomInt(REFERRAL_ALPHABET.length)];
      }
      const existing = await this.prisma.customer.findUnique({
        where: { referralCode: code },
        select: { id: true },
      });
      if (!existing) return code;
    }
    throw new BadRequestException('Could not assign a referral code');
  }

  private async restaurantId(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { restaurantId: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch.restaurantId;
  }

  private async assertInBranch(branchId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, branchId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
  }
}
