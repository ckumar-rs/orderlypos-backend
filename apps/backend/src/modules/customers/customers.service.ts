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
  CustomerFollowUpDto,
  CustomerNoteDto,
  EmployeeDiscountPolicyDto,
  LoyaltyRuleDto,
  MembershipTierDto,
  RewardDto,
  RfmLabelDto,
} from '@nodedr-restaurant/types';
import { parseCsvLine } from '../accounting/ledger.service';
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

  async updateReward(branchId: string, id: string, dto: Partial<RewardDto>) {
    const reward = await this.prisma.reward.findFirst({ where: { id, branchId } });
    if (!reward) throw new NotFoundException('Reward not found');
    return this.prisma.reward.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.pointsCost !== undefined ? { pointsCost: dto.pointsCost } : {}),
        ...(dto.cashbackCost !== undefined
          ? { cashbackCost: dto.cashbackCost }
          : {}),
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

  async updateEmployeeDiscount(
    branchId: string,
    id: string,
    dto: { percent?: number; maxAmount?: number | null; isActive?: boolean },
  ) {
    const row = await this.prisma.employeeDiscount.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Staff discount not found');
    return this.prisma.employeeDiscount.update({
      where: { id },
      data: {
        ...(dto.percent !== undefined ? { percent: dto.percent } : {}),
        ...(dto.maxAmount !== undefined ? { maxAmount: dto.maxAmount } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
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

  /**
   * Import guests from CSV (name, phone, email). Matches existing rows by
   * phone (last 10 digits) or email hash, then creates or updates.
   */
  async importCsv(branchId: string, csv: string) {
    const lines = csv
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter((l) => l.trim());
    if (lines.length < 2) {
      throw new BadRequestException('CSV needs a header row and at least one guest');
    }
    if (lines.length - 1 > 5_000) {
      throw new BadRequestException('Import at most 5,000 guests at once');
    }

    const head = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
    const col = (...names: string[]) =>
      head.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    const iName = col('name', 'guest', 'customer');
    const iPhone = col('phone', 'mobile', 'msisdn', 'tel');
    const iEmail = col('email', 'e-mail', 'mail');
    if (iPhone < 0 && iEmail < 0) {
      throw new BadRequestException(
        'CSV needs a phone and/or email column (and optional name)',
      );
    }

    const existing = await this.prisma.customer.findMany({
      where: { branchId },
      select: { id: true, phone: true, emailLookup: true, name: true },
    });
    const byPhone = new Map<string, string>();
    const byEmail = new Map<string, string>();
    for (const row of existing) {
      const digits = (row.phone ?? '').replace(/\D/g, '');
      if (digits.length >= 8) byPhone.set(digits.slice(-10), row.id);
      if (row.emailLookup) byEmail.set(row.emailLookup, row.id);
    }

    let created = 0;
    let updated = 0;
    const errors: { row: number; reason: string }[] = [];

    for (let i = 1; i < lines.length; i++) {
      const rowNum = i + 1;
      const cells = parseCsvLine(lines[i]);
      if (cells.every((c) => !c.trim())) continue;

      const name = (iName >= 0 ? cells[iName] : '')?.trim() || undefined;
      let phone = (iPhone >= 0 ? cells[iPhone] : '')?.trim() || undefined;
      let email = (iEmail >= 0 ? cells[iEmail] : '')?.trim() || undefined;
      if (phone) phone = phone.replace(/[^\d+]/g, '');
      if (email) email = email.toLowerCase();

      if (!phone && !email) {
        errors.push({ row: rowNum, reason: 'Need a phone or email' });
        continue;
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push({ row: rowNum, reason: 'Invalid email' });
        continue;
      }
      const phoneDigits = (phone ?? '').replace(/\D/g, '');
      if (phone && phoneDigits.length < 8) {
        errors.push({ row: rowNum, reason: 'Phone looks too short' });
        continue;
      }

      try {
        const matchId =
          (phoneDigits.length >= 8
            ? byPhone.get(phoneDigits.slice(-10))
            : undefined) ??
          (email ? byEmail.get(hashEmail(email)) : undefined);

        if (matchId) {
          const data = await this.customerData(branchId, {
            ...(name ? { name } : {}),
            ...(phone ? { phone } : {}),
            ...(email ? { email } : {}),
          }, matchId);
          await this.prisma.customer.update({ where: { id: matchId }, data });
          updated += 1;
        } else {
          const data = await this.customerData(branchId, {
            name,
            phone,
            email,
          });
          const row = await this.prisma.customer.create({
            data: { ...data, branchId },
          });
          created += 1;
          if (phoneDigits.length >= 8) byPhone.set(phoneDigits.slice(-10), row.id);
          if (email) byEmail.set(hashEmail(email), row.id);
        }
      } catch (err) {
        errors.push({
          row: rowNum,
          reason: err instanceof Error ? err.message : 'Could not save row',
        });
      }
    }

    return {
      created,
      updated,
      skipped: errors.length,
      errors: errors.slice(0, 50),
    };
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

  async updateTier(branchId: string, id: string, dto: MembershipTierDto) {
    const restaurantId = await this.restaurantId(branchId);
    const tier = await this.prisma.membershipTier.findFirst({
      where: { id, restaurantId },
    });
    if (!tier) throw new NotFoundException('Membership tier not found');
    return this.prisma.membershipTier.update({
      where: { id },
      data: {
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

  /** Unified guest activity: notes, follow-ups, paid orders, outbound messages. */
  async timeline(branchId: string, customerId: string, take = 60) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, branchId },
      select: {
        id: true,
        phone: true,
        notes: true,
        createdAt: true,
        branch: { select: { restaurantId: true } },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const limit = Math.min(100, Math.max(1, take));
    const phoneDigits = (customer.phone ?? '').replace(/\D/g, '');
    const [notes, followUps, orders, messages] = await Promise.all([
      this.prisma.customerNote.findMany({
        where: { customerId, branchId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { createdBy: { select: { id: true, name: true } } },
      }),
      this.prisma.customerFollowUp.findMany({
        where: { customerId, branchId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          createdBy: { select: { id: true, name: true } },
          completedBy: { select: { id: true, name: true } },
        },
      }),
      this.prisma.order.findMany({
        where: { customerId, branchId, status: 'PAID' },
        orderBy: { billedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          orderNumber: true,
          totalAmount: true,
          billedAt: true,
        },
      }),
      phoneDigits.length >= 8
        ? this.prisma.outboundMessage.findMany({
            where: {
              restaurantId: customer.branch.restaurantId,
              purpose: 'CAMPAIGN',
              OR: [
                { to: { contains: phoneDigits.slice(-10) } },
                ...(customer.phone ? [{ to: { contains: customer.phone } }] : []),
              ],
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: {
              id: true,
              channel: true,
              status: true,
              body: true,
              provider: true,
              createdAt: true,
              sentAt: true,
              deliveredAt: true,
              readAt: true,
              error: true,
            },
          })
        : Promise.resolve([]),
    ]);

    type Event = {
      id: string;
      kind: string;
      at: string;
      title: string;
      detail?: string | null;
      meta?: Record<string, unknown>;
    };

    const events: Event[] = [];

    for (const note of notes) {
      events.push({
        id: `note:${note.id}`,
        kind: 'NOTE',
        at: note.createdAt.toISOString(),
        title: 'Staff note',
        detail: note.body,
        meta: { createdBy: note.createdBy?.name ?? null },
      });
    }
    for (const row of followUps) {
      events.push({
        id: `followup:${row.id}`,
        kind: row.doneAt ? 'FOLLOW_UP_DONE' : 'FOLLOW_UP',
        at: (row.doneAt ?? row.createdAt).toISOString(),
        title: row.doneAt ? `Completed: ${row.title}` : `Follow-up: ${row.title}`,
        detail: row.body,
        meta: {
          dueAt: row.dueAt?.toISOString() ?? null,
          createdBy: row.createdBy?.name ?? null,
          completedBy: row.completedBy?.name ?? null,
          followUpId: row.id,
          done: Boolean(row.doneAt),
        },
      });
    }
    for (const order of orders) {
      events.push({
        id: `order:${order.id}`,
        kind: 'ORDER',
        at: (order.billedAt ?? new Date()).toISOString(),
        title: `Paid order #${order.orderNumber}`,
        detail: null,
        meta: { totalAmount: order.totalAmount, orderId: order.id },
      });
    }
    for (const msg of messages) {
      events.push({
        id: `msg:${msg.id}`,
        kind: 'MESSAGE',
        at: (msg.sentAt ?? msg.createdAt).toISOString(),
        title: `${msg.channel} ${msg.status.toLowerCase()}`,
        detail: msg.body.slice(0, 160),
        meta: {
          status: msg.status,
          provider: msg.provider,
          error: msg.error,
          deliveredAt: msg.deliveredAt?.toISOString() ?? null,
          readAt: msg.readAt?.toISOString() ?? null,
        },
      });
    }
    if (customer.notes?.trim()) {
      events.push({
        id: `legacy-notes:${customer.id}`,
        kind: 'NOTE',
        at: customer.createdAt.toISOString(),
        title: 'Profile notes',
        detail: customer.notes,
        meta: { legacy: true },
      });
    }

    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return { events: events.slice(0, limit) };
  }

  async addNote(
    branchId: string,
    customerId: string,
    userId: string,
    dto: CustomerNoteDto,
  ) {
    await this.assertInBranch(branchId, customerId);
    return this.prisma.customerNote.create({
      data: {
        branchId,
        customerId,
        body: dto.body.trim(),
        createdByUserId: userId,
      },
      include: { createdBy: { select: { id: true, name: true } } },
    });
  }

  async listFollowUps(branchId: string, customerId: string, openOnly = false) {
    await this.assertInBranch(branchId, customerId);
    return this.prisma.customerFollowUp.findMany({
      where: {
        branchId,
        customerId,
        ...(openOnly ? { doneAt: null } : {}),
      },
      orderBy: [{ doneAt: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
      include: {
        createdBy: { select: { id: true, name: true } },
        completedBy: { select: { id: true, name: true } },
      },
    });
  }

  async createFollowUp(
    branchId: string,
    customerId: string,
    userId: string,
    dto: CustomerFollowUpDto,
  ) {
    await this.assertInBranch(branchId, customerId);
    return this.prisma.customerFollowUp.create({
      data: {
        branchId,
        customerId,
        title: dto.title.trim(),
        body: dto.body?.trim() || null,
        dueAt: dto.dueAt ?? null,
        createdByUserId: userId,
      },
      include: {
        createdBy: { select: { id: true, name: true } },
        completedBy: { select: { id: true, name: true } },
      },
    });
  }

  async completeFollowUp(
    branchId: string,
    customerId: string,
    followUpId: string,
    userId: string,
  ) {
    const row = await this.prisma.customerFollowUp.findFirst({
      where: { id: followUpId, customerId, branchId },
    });
    if (!row) throw new NotFoundException('Follow-up not found');
    if (row.doneAt) return row;
    return this.prisma.customerFollowUp.update({
      where: { id: followUpId },
      data: { doneAt: new Date(), completedByUserId: userId },
      include: {
        createdBy: { select: { id: true, name: true } },
        completedBy: { select: { id: true, name: true } },
      },
    });
  }

  async reopenFollowUp(branchId: string, customerId: string, followUpId: string) {
    const row = await this.prisma.customerFollowUp.findFirst({
      where: { id: followUpId, customerId, branchId },
    });
    if (!row) throw new NotFoundException('Follow-up not found');
    return this.prisma.customerFollowUp.update({
      where: { id: followUpId },
      data: { doneAt: null, completedByUserId: null },
      include: {
        createdBy: { select: { id: true, name: true } },
        completedBy: { select: { id: true, name: true } },
      },
    });
  }

  /** Open follow-ups due today or overdue across the branch (staff inbox). */
  async dueFollowUps(branchId: string) {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return this.prisma.customerFollowUp.findMany({
      where: {
        branchId,
        doneAt: null,
        OR: [{ dueAt: null }, { dueAt: { lte: end } }],
      },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      take: 50,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
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
