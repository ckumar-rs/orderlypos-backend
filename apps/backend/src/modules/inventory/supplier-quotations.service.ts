import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  QuotationStatus,
  SupplierQuotationDto,
} from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';

const NEXT_STATUS: Record<QuotationStatus, QuotationStatus[]> = {
  DRAFT: ['RECEIVED'],
  RECEIVED: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: [],
  REJECTED: [],
};

@Injectable()
export class SupplierQuotationsService {
  constructor(private readonly prisma: PrismaService) {}

  listQuotations(branchId: string, ingredientId?: string) {
    return this.prisma.supplierQuotation.findMany({
      where: {
        branchId,
        ...(ingredientId ? { items: { some: { ingredientId } } } : {}),
      },
      include: {
        supplier: { select: { id: true, name: true } },
        items: { include: { ingredient: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getQuotation(branchId: string, id: string) {
    const quotation = await this.prisma.supplierQuotation.findFirst({
      where: { id, branchId },
      include: {
        supplier: true,
        items: { include: { ingredient: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
    if (!quotation) throw new NotFoundException('Quotation not found');
    return quotation;
  }

  // Compares the cheapest ACCEPTED-or-RECEIVED quotation per supplier for one
  // ingredient — the actual point of collecting quotations at all.
  async compareForIngredient(branchId: string, ingredientId: string) {
    const items = await this.prisma.supplierQuotationItem.findMany({
      where: {
        ingredientId,
        supplierQuotation: {
          branchId,
          status: { in: ['RECEIVED', 'ACCEPTED'] },
        },
      },
      include: {
        supplierQuotation: { include: { supplier: true } },
      },
      orderBy: { unitPrice: 'asc' },
    });
    return items.map((item) => ({
      supplierId: item.supplierQuotation.supplierId,
      supplierName: item.supplierQuotation.supplier.name,
      quotationId: item.supplierQuotationId,
      quotationNumber: item.supplierQuotation.quotationNumber,
      unitPrice: item.unitPrice,
      quantityQuoted: item.quantityQuoted,
      validUntil: item.supplierQuotation.validUntil,
    }));
  }

  async createQuotation(
    branchId: string,
    userId: string,
    dto: SupplierQuotationDto,
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

    const quotationNumber = await this.nextQuotationNumber(branchId);

    return this.prisma.supplierQuotation.create({
      data: {
        branchId,
        supplierId: dto.supplierId,
        quotationNumber,
        validUntil: dto.validUntil,
        notes: dto.notes,
        createdById: userId,
        items: {
          create: dto.items.map((i) => ({
            ingredientId: i.ingredientId,
            quantityQuoted: i.quantityQuoted,
            unitPrice: i.unitPrice,
          })),
        },
      },
      include: { items: true },
    });
  }

  async updateStatus(branchId: string, id: string, status: QuotationStatus) {
    const quotation = await this.getQuotation(branchId, id);
    const allowed = NEXT_STATUS[quotation.status];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Cannot move quotation from ${quotation.status} to ${status}`,
      );
    }
    return this.prisma.supplierQuotation.update({
      where: { id },
      data: { status },
    });
  }

  private async nextQuotationNumber(branchId: string): Promise<string> {
    const count = await this.prisma.supplierQuotation.count({
      where: { branchId },
    });
    return `QT-${String(count + 1).padStart(4, '0')}`;
  }
}
