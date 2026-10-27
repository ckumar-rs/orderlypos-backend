import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateIntegrationOrderDto,
  CreateIntegrationReservationDto,
} from '@nodedr-restaurant/types';
import { PrismaService } from '../prisma/prisma.service';
import { DeliveryService } from '../modules/delivery/delivery.service';
import { OrdersService } from '../modules/orders/orders.service';
import { ReservationsService } from '../modules/reservations/reservations.service';

export interface IntegrationKeyContext {
  id: string;
  restaurantId: string;
  branchId: string | null;
  scopes: string[];
}

/**
 * Backs the public REST API external websites use as a backend (see
 * docs/integrations-api.md). Every method takes the caller's
 * IntegrationKeyContext and re-validates the requested branch belongs to
 * that key's restaurant AND (if the key itself is scoped to one location)
 * matches exactly — never trusts a client-supplied branchId on its own,
 * same discipline OrdersService/ReservationsService already apply to
 * staff-supplied tableId/customerId.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly delivery: DeliveryService,
    private readonly reservations: ReservationsService,
  ) {}

  private async assertBranch(ctx: IntegrationKeyContext, branchId: string) {
    if (ctx.branchId && ctx.branchId !== branchId) {
      throw new ForbiddenException(
        'This API key is scoped to a different location',
      );
    }
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, restaurantId: ctx.restaurantId, isActive: true },
    });
    if (!branch) {
      throw new NotFoundException('Location not found');
    }
    return branch;
  }

  async listLocations(ctx: IntegrationKeyContext) {
    return this.prisma.branch.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        isActive: true,
        ...(ctx.branchId ? { id: ctx.branchId } : {}),
      },
      select: { id: true, name: true, address: true, phone: true },
      orderBy: { name: 'asc' },
    });
  }

  async getMenu(ctx: IntegrationKeyContext, branchId: string) {
    const branch = await this.assertBranch(ctx, branchId);
    const categories = await this.prisma.menuCategory.findMany({
      where: { branchId: branch.id, isActive: true, showOnWebsite: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        items: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            description: true,
            imageUrl: true,
            price: true,
            isVeg: true,
            isVegan: true,
            spiceLevel: true,
            allergens: true,
          },
        },
      },
    });
    return { locationId: branch.id, locationName: branch.name, categories };
  }

  async createOrder(
    ctx: IntegrationKeyContext,
    branchId: string,
    dto: CreateIntegrationOrderDto,
  ) {
    await this.assertBranch(ctx, branchId);

    // find-or-attach a lightweight Customer record so repeat integration
    // orders from the same phone number accumulate under one profile —
    // same idea as the in-app POS's walk-in customer capture, just keyed
    // by phone since that's the only identity an external order carries.
    const existing = await this.prisma.customer.findFirst({
      where: { branchId, phone: dto.customerPhone },
    });
    const customer = existing
      ? await this.prisma.customer.update({
          where: { id: existing.id },
          data: { name: dto.customerName || existing.name },
        })
      : await this.prisma.customer.create({
          data: { branchId, name: dto.customerName, phone: dto.customerPhone },
        });

    // An external order has no staff member behind it, but Order.createdById
    // is a required FK — attribute it to any staff linked to the branch
    // (every branch has at least its owner), same fallback the QR
    // self-order flow already uses for the identical reason.
    const createdById = (
      await this.prisma.userBranch.findFirst({
        where: { branchId },
        orderBy: { userId: 'asc' },
      })
    )?.userId;
    if (!createdById) {
      throw new NotFoundException(
        'This location has no staff to receive the order',
      );
    }

    return this.orders.createOrder(
      branchId,
      createdById,
      {
        type: dto.type,
        customerId: customer.id,
        guestName: dto.customerName,
        notes: dto.notes,
        delivery: dto.delivery,
        scheduledFor: dto.scheduledFor,
        items: dto.items.map((item) => ({
          menuItemId: item.menuItemId,
          quantity: item.quantity,
          modifierIds: item.modifierIds,
          kitchenNote: item.kitchenNote,
        })),
      },
      { channel: 'ONLINE', requireAcceptance: true },
    );
  }

  /** Fee / minimum / ETA for a pincode, so a website can quote before ordering. */
  async deliveryQuote(
    ctx: IntegrationKeyContext,
    branchId: string,
    pincode: string,
  ) {
    await this.assertBranch(ctx, branchId);
    return this.delivery.quote(branchId, pincode);
  }

  async getOrder(
    ctx: IntegrationKeyContext,
    branchId: string,
    orderId: string,
  ) {
    await this.assertBranch(ctx, branchId);
    return this.orders.getOrder(branchId, orderId);
  }

  async createReservation(
    ctx: IntegrationKeyContext,
    branchId: string,
    dto: CreateIntegrationReservationDto,
  ) {
    await this.assertBranch(ctx, branchId);
    return this.reservations.create(branchId, dto, { fromWebsite: true });
  }

  async getReservation(
    ctx: IntegrationKeyContext,
    branchId: string,
    reservationId: string,
  ) {
    await this.assertBranch(ctx, branchId);
    const reservation = await this.prisma.reservation.findFirst({
      where: { id: reservationId, branchId },
    });
    if (!reservation) throw new NotFoundException('Reservation not found');
    return reservation;
  }
}
