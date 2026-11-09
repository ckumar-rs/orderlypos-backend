import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Read-only takeaway / kiosk queue for a public display token. */
@Injectable()
export class PublicPickupService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveBranch(token: string) {
    if (!/^[a-f0-9]{32}$/.test(token)) {
      throw new NotFoundException('This pickup board is not available');
    }
    const branch = await this.prisma.branch.findUnique({
      where: { pickupDisplayToken: token },
      include: { restaurant: { select: { name: true } } },
    });
    if (!branch || !branch.isActive) {
      throw new NotFoundException('This pickup board is not available');
    }
    return branch;
  }

  async getQueue(token: string) {
    const branch = await this.resolveBranch(token);
    const orders = await this.prisma.order.findMany({
      where: {
        branchId: branch.id,
        type: { in: ['KIOSK', 'TAKEAWAY'] },
        status: { in: ['OPEN', 'BILLED', 'PAID'] },
        OR: [
          { kots: { some: { status: { in: ['NEW', 'ACCEPTED', 'PREPARING', 'READY'] } } } },
          { heldAt: { not: null }, status: { in: ['OPEN', 'BILLED'] } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 40,
      select: {
        orderNumber: true,
        type: true,
        status: true,
        heldAt: true,
        guestName: true,
        createdAt: true,
        kots: {
          where: { status: { in: ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED'] } },
          select: { status: true },
        },
      },
    });
    return {
      restaurantName: branch.restaurant.name,
      branchName: branch.name,
      tickets: orders.map((order) => {
        const statuses = order.kots.map((kot) => kot.status);
        const cooking = statuses.some((s) =>
          s === 'NEW' || s === 'ACCEPTED' || s === 'PREPARING',
        );
        let stage: 'WAITING_PAYMENT' | 'PREPARING' | 'READY' = 'PREPARING';
        if (order.heldAt && order.status !== 'PAID') stage = 'WAITING_PAYMENT';
        else if (statuses.length > 0 && !cooking) stage = 'READY';
        return {
          orderNumber: order.orderNumber,
          token: order.orderNumber.split('-').pop() ?? order.orderNumber,
          type: order.type,
          guestName: order.guestName,
          stage,
          createdAt: order.createdAt,
        };
      }),
    };
  }
}
