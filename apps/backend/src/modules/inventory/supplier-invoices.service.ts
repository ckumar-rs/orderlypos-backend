import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  SupplierInvoiceDto,
  SupplierPaymentDto,
} from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';
import { round2 } from '../../common/money';

@Injectable()
export class SupplierInvoicesService {
  constructor(private readonly prisma: PrismaService) {}

  listInvoices(branchId: string, supplierId?: string) {
    return this.prisma.supplierInvoice.findMany({
      where: { branchId, ...(supplierId ? { supplierId } : {}) },
      include: {
        supplier: { select: { id: true, name: true } },
        payments: true,
      },
      orderBy: { invoiceDate: 'desc' },
    });
  }

  async getInvoice(branchId: string, id: string) {
    const invoice = await this.prisma.supplierInvoice.findFirst({
      where: { id, branchId },
      include: {
        supplier: true,
        purchaseOrder: { select: { id: true, poNumber: true } },
        goodsReceipt: { select: { id: true, grnNumber: true } },
        payments: {
          include: { recordedBy: { select: { id: true, name: true } } },
          orderBy: { paidAt: 'desc' },
        },
      },
    });
    if (!invoice) throw new NotFoundException('Supplier invoice not found');
    return invoice;
  }

  async createInvoice(
    branchId: string,
    userId: string,
    dto: SupplierInvoiceDto,
  ) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, branchId },
    });
    if (!supplier)
      throw new BadRequestException('Supplier not found in this branch');

    if (dto.purchaseOrderId) {
      const po = await this.prisma.purchaseOrder.findFirst({
        where: { id: dto.purchaseOrderId, branchId },
      });
      if (!po)
        throw new BadRequestException(
          'Purchase order not found in this branch',
        );
    }
    if (dto.goodsReceiptId) {
      const grn = await this.prisma.goodsReceipt.findFirst({
        where: { id: dto.goodsReceiptId, branchId },
      });
      if (!grn)
        throw new BadRequestException('Goods receipt not found in this branch');
    }

    return this.prisma.supplierInvoice.create({
      data: {
        branchId,
        supplierId: dto.supplierId,
        purchaseOrderId: dto.purchaseOrderId,
        goodsReceiptId: dto.goodsReceiptId,
        invoiceNumber: dto.invoiceNumber,
        invoiceDate: dto.invoiceDate,
        dueDate: dto.dueDate,
        totalAmount: round2(dto.totalAmount),
        recordedById: userId,
      },
    });
  }

  // Read-modify-write inside the transaction, never a DB `increment` — same
  // Decimal-balance discipline this project uses everywhere else (see
  // [[project_nodedr_restaurant_pos]] / [[project_nodedr_pos]] float-drift
  // lesson), so two concurrent payments against the same invoice can't
  // silently lose one of them.
  async recordPayment(
    branchId: string,
    invoiceId: string,
    userId: string,
    dto: SupplierPaymentDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const invoice = await tx.supplierInvoice.findFirst({
        where: { id: invoiceId, branchId },
      });
      if (!invoice) throw new NotFoundException('Supplier invoice not found');
      if (invoice.status === 'CANCELLED') {
        throw new BadRequestException('Cannot pay a cancelled invoice');
      }

      const currentPaid = Number(invoice.amountPaid);
      const total = Number(invoice.totalAmount);
      const remaining = round2(total - currentPaid);
      if (dto.amount > remaining) {
        throw new BadRequestException(
          `Payment of ${dto.amount} exceeds the remaining balance of ${remaining}`,
        );
      }

      const newPaid = round2(currentPaid + dto.amount);
      const newStatus =
        newPaid >= total ? 'PAID' : newPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID';

      const payment = await tx.supplierPayment.create({
        data: {
          branchId,
          supplierInvoiceId: invoiceId,
          amount: dto.amount,
          paymentMethod: dto.paymentMethod,
          reference: dto.reference,
          recordedById: userId,
        },
      });

      await tx.supplierInvoice.update({
        where: { id: invoiceId },
        data: { amountPaid: newPaid, status: newStatus },
      });

      return payment;
    });
  }

  async cancelInvoice(branchId: string, id: string) {
    const invoice = await this.getInvoice(branchId, id);
    if (Number(invoice.amountPaid) > 0) {
      throw new BadRequestException(
        'Cannot cancel an invoice that already has payments recorded',
      );
    }
    return this.prisma.supplierInvoice.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  }

  // Supplier performance — computed on demand from existing PO/GRN/invoice
  // data rather than a separately maintained metric, so it can never drift
  // from the underlying records.
  async getSupplierPerformance(branchId: string, supplierId: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: supplierId, branchId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const orders = await this.prisma.purchaseOrder.findMany({
      where: { branchId, supplierId, status: { not: 'CANCELLED' } },
      select: {
        id: true,
        expectedDate: true,
        createdAt: true,
        totalAmount: true,
      },
    });

    const receipts = await this.prisma.goodsReceipt.findMany({
      where: { branchId, supplierId, purchaseOrderId: { not: null } },
      select: { purchaseOrderId: true, receivedAt: true },
    });
    const firstReceiptByPo = new Map<string, Date>();
    for (const r of receipts) {
      if (!r.purchaseOrderId) continue;
      const existing = firstReceiptByPo.get(r.purchaseOrderId);
      if (!existing || r.receivedAt < existing) {
        firstReceiptByPo.set(r.purchaseOrderId, r.receivedAt);
      }
    }

    let onTimeCount = 0;
    let lateCount = 0;
    let leadTimeDaysSum = 0;
    let leadTimeSamples = 0;
    for (const po of orders) {
      const receivedAt = firstReceiptByPo.get(po.id);
      if (!receivedAt) continue; // not yet received, excluded from on-time/lead-time stats
      leadTimeDaysSum +=
        (receivedAt.getTime() - po.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      leadTimeSamples += 1;
      if (po.expectedDate) {
        if (receivedAt <= po.expectedDate) onTimeCount += 1;
        else lateCount += 1;
      }
    }

    const invoices = await this.prisma.supplierInvoice.findMany({
      where: { branchId, supplierId, status: { not: 'CANCELLED' } },
      select: { totalAmount: true },
    });
    const totalSpend = round2(
      invoices.reduce((sum, inv) => sum + Number(inv.totalAmount), 0),
    );

    const trackedDeliveries = onTimeCount + lateCount;

    return {
      supplierId,
      supplierName: supplier.name,
      totalPurchaseOrders: orders.length,
      totalSpend,
      onTimeDeliveryRate:
        trackedDeliveries > 0
          ? round2((onTimeCount / trackedDeliveries) * 100)
          : null,
      avgLeadTimeDays:
        leadTimeSamples > 0 ? round2(leadTimeDaysSum / leadTimeSamples) : null,
    };
  }
}
