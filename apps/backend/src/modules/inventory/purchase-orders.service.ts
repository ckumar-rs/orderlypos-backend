import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  PurchaseOrderDto,
  PurchaseOrderStatus,
} from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { round2 } from '../../common/money';

const NEXT_STATUS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['CANCELLED'], // PARTIALLY_RECEIVED/RECEIVED are set by GoodsReceiptsService, not manually
  PARTIALLY_RECEIVED: [],
  RECEIVED: [],
  CANCELLED: [],
};

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  listPurchaseOrders(branchId: string, status?: PurchaseOrderStatus) {
    return this.prisma.purchaseOrder.findMany({
      where: { branchId, ...(status ? { status } : {}) },
      include: {
        supplier: { select: { id: true, name: true } },
        items: true,
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPurchaseOrder(branchId: string, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, branchId },
      include: {
        supplier: true,
        createdBy: { select: { id: true, name: true } },
        items: { include: { ingredient: true } },
        goodsReceipts: {
          include: {
            items: true,
            receivedBy: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  async createPurchaseOrder(
    branchId: string,
    userId: string,
    dto: PurchaseOrderDto,
  ) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, branchId },
    });
    if (!supplier)
      throw new BadRequestException('Supplier not found in this branch');

    const ingredientIds = dto.items.map((i) => i.ingredientId);
    const ingredientCount = await this.prisma.ingredient.count({
      where: { id: { in: ingredientIds }, branchId },
    });
    if (ingredientCount !== new Set(ingredientIds).size) {
      throw new BadRequestException(
        'One or more ingredients not found in this branch',
      );
    }

    const totalAmount = round2(
      dto.items.reduce((sum, i) => sum + i.quantityOrdered * i.unitCost, 0),
    );
    const poNumber = await this.nextPoNumber(branchId);

    return this.prisma.purchaseOrder.create({
      data: {
        branchId,
        supplierId: dto.supplierId,
        poNumber,
        expectedDate: dto.expectedDate,
        notes: dto.notes,
        totalAmount,
        createdById: userId,
        items: {
          create: dto.items.map((i) => ({
            ingredientId: i.ingredientId,
            quantityOrdered: i.quantityOrdered,
            unitCost: i.unitCost,
          })),
        },
      },
      include: { items: true },
    });
  }

  async updateStatus(
    branchId: string,
    id: string,
    status: PurchaseOrderStatus,
  ) {
    const po = await this.getPurchaseOrder(branchId, id);
    const allowed = NEXT_STATUS[po.status];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Cannot move purchase order from ${po.status} to ${status}`,
      );
    }
    if (status === 'SENT') {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { name: true, restaurant: { select: { demoMode: true, name: true } } },
      });
      if (branch?.restaurant.demoMode) {
        throw new BadRequestException(
          'Demo mode keeps purchase orders as drafts and does not email a supplier.',
        );
      }
      const to = po.supplier.email?.trim();
      if (!to) {
        throw new BadRequestException(
          'This supplier has no email address, so the purchase order stays a draft.',
        );
      }
      if (!this.email.isConfigured()) {
        throw new BadRequestException(
          'Email is not set up (SMTP_URL and SMTP_FROM), so the purchase order stays a draft.',
        );
      }
      const lines = po.items
        .map(
          (item) =>
            `${item.ingredient.name}: ${item.quantityOrdered} at ${item.unitCost}`,
        )
        .join('\n');
      try {
        await this.email.send({
          to,
          subject: `Purchase order ${po.poNumber} from ${branch?.restaurant.name ?? 'the restaurant'}`,
          text: [
            `Purchase order ${po.poNumber}`,
            branch ? `Branch: ${branch.name}` : '',
            '',
            lines,
            '',
            po.notes ?? '',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        });
      } catch (err) {
        throw new BadRequestException(
          `The email could not be sent, so the purchase order stays a draft. ${err instanceof Error ? err.message : ''}`.trim(),
        );
      }
    }
    return this.prisma.purchaseOrder.update({
      where: { id },
      data: {
        status,
        ...(status === 'SENT'
          ? {
              notes: po.notes
                ? `${po.notes}\nEmailed to ${po.supplier.email}`
                : `Emailed to ${po.supplier.email}`,
            }
          : {}),
      },
    });
  }

  private async nextPoNumber(branchId: string): Promise<string> {
    const count = await this.prisma.purchaseOrder.count({
      where: { branchId },
    });
    return `PO-${String(count + 1).padStart(4, '0')}`;
  }
}
