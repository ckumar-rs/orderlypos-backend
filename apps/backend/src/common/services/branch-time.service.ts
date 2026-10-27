import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Looks up the restaurant timezone a branch's reports should be cut in. */
@Injectable()
export class BranchTimeService {
  constructor(private readonly prisma: PrismaService) {}

  async tzForBranch(branchId: string): Promise<string> {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { restaurant: { select: { timezone: true } } },
    });
    return branch?.restaurant.timezone ?? 'Asia/Kolkata';
  }

  async tzForRestaurant(restaurantId: string): Promise<string> {
    const r = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { timezone: true },
    });
    return r?.timezone ?? 'Asia/Kolkata';
  }
}
