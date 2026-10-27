import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { IssueGiftCardDto } from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';
import { round2 } from '../orders/pricing';

@Injectable()
export class GiftCardsService {
  constructor(private readonly prisma: PrismaService) {}

  list(branchId: string) {
    return this.prisma.giftCard.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async issue(branchId: string, dto: IssueGiftCardDto) {
    // A client-supplied customerId from another branch/restaurant must
    // never be trusted directly — without this check, a gift card issued
    // by this branch could be linked to a foreign tenant's customer record.
    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, branchId },
        select: { id: true },
      });
      if (!customer) {
        throw new BadRequestException('Customer is invalid for this branch');
      }
    }

    const code = randomBytes(6).toString('hex').toUpperCase();
    const value = round2(dto.initialValue);
    return this.prisma.giftCard.create({
      data: {
        branchId,
        code,
        initialValue: value,
        balance: value,
        customerId: dto.customerId,
      },
    });
  }

  async getByCode(branchId: string, code: string) {
    const card = await this.prisma.giftCard.findFirst({
      where: { code: code.toUpperCase(), branchId },
    });
    if (!card) throw new NotFoundException('Gift card not found');
    return card;
  }

  /**
   * Debits up to `maxAmount` from the card (never more than its balance),
   * returns the amount actually applied. Caller runs this inside the same
   * `$transaction` as the order update.
   *
   * The balance column is `Decimal(12,2)` (exact fixed-point in Postgres,
   * not a float) so a DB-side `decrement` has no precision downside here —
   * and it's what closes a real race: two concurrent checkouts redeeming
   * the same gift card could otherwise both read the same stale `balance`
   * and both write a `set`-based update, silently losing one debit (the
   * card ends up overdrawn relative to what was actually redeemed). The
   * guarded `updateMany` (`balance >= amountApplied` at update time, not at
   * read time) only lets the update through if the balance is still
   * sufficient when it actually runs; the loser gets `count === 0` and
   * fails loudly instead of corrupting the balance.
   */
  async debit(
    tx: Prisma.TransactionClient,
    branchId: string,
    code: string,
    maxAmount: number,
  ): Promise<{ giftCardId: string; amountApplied: number }> {
    const card = await tx.giftCard.findFirst({
      where: { code: code.toUpperCase(), branchId },
    });
    if (!card || !card.isActive)
      throw new BadRequestException('Gift card not found or inactive');

    const balance = Number(card.balance);
    if (balance <= 0)
      throw new BadRequestException('Gift card has no balance remaining');

    const amountApplied = round2(Math.min(balance, maxAmount));
    const result = await tx.giftCard.updateMany({
      where: { id: card.id, balance: { gte: amountApplied } },
      data: { balance: { decrement: amountApplied } },
    });
    if (result.count === 0) {
      throw new BadRequestException(
        'Gift card balance changed — please retry checkout',
      );
    }

    return { giftCardId: card.id, amountApplied };
  }
}
