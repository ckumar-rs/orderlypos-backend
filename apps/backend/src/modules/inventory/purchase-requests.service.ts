import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  PurchaseRequestDto,
  PurchaseRequestStatus,
} from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';

const NEXT_STATUS: Record<PurchaseRequestStatus, PurchaseRequestStatus[]> = {
  DRAFT: ['PENDING_APPROVAL'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
  APPROVED: ['CONVERTED'],
  REJECTED: [],
  CONVERTED: [],
};

@Injectable()
export class PurchaseRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  listPurchaseRequests(branchId: string, status?: PurchaseRequestStatus) {
    return this.prisma.purchaseRequest.findMany({
      where: { branchId, ...(status ? { status } : {}) },
      include: {
        items: { include: { ingredient: true } },
        requestedBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPurchaseRequest(branchId: string, id: string) {
    const request = await this.prisma.purchaseRequest.findFirst({
      where: { id, branchId },
      include: {
        items: { include: { ingredient: true } },
        requestedBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
      },
    });
    if (!request) throw new NotFoundException('Purchase request not found');
    return request;
  }

  async createPurchaseRequest(
    branchId: string,
    userId: string,
    dto: PurchaseRequestDto,
  ) {
    const ingredientIds = dto.items.map((i) => i.ingredientId);
    const ingredientCount = await this.prisma.ingredient.count({
      where: { id: { in: ingredientIds }, branchId },
    });
    if (ingredientCount !== new Set(ingredientIds).size) {
      throw new BadRequestException(
        'One or more ingredients not found in this branch',
      );
    }

    const requestNumber = await this.nextRequestNumber(branchId);

    return this.prisma.purchaseRequest.create({
      data: {
        branchId,
        requestNumber,
        notes: dto.notes,
        requestedById: userId,
        items: {
          create: dto.items.map((i) => ({
            ingredientId: i.ingredientId,
            quantityRequested: i.quantityRequested,
            notes: i.notes,
          })),
        },
      },
      include: { items: true },
    });
  }

  async updateStatus(
    branchId: string,
    id: string,
    userId: string,
    status: PurchaseRequestStatus,
  ) {
    const request = await this.getPurchaseRequest(branchId, id);
    const allowed = NEXT_STATUS[request.status];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `Cannot move purchase request from ${request.status} to ${status}`,
      );
    }
    return this.prisma.purchaseRequest.update({
      where: { id },
      data: {
        status,
        // Only stamp approvedById on the transition that actually approves it —
        // a later REJECTED-from-something-else path (none exist today, but if
        // one is added) must not silently attribute it to this approver.
        ...(status === 'APPROVED' ? { approvedById: userId } : {}),
      },
    });
  }

  private async nextRequestNumber(branchId: string): Promise<string> {
    const count = await this.prisma.purchaseRequest.count({
      where: { branchId },
    });
    return `PR-${String(count + 1).padStart(4, '0')}`;
  }
}
