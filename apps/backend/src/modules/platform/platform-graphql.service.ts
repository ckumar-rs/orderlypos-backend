import { Injectable } from '@nestjs/common';
import { graphql, type GraphQLError } from 'graphql';
import type { SessionUser } from '@nodedr-restaurant/types';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { PlatformService } from './platform.service';
import { platformSchema } from './graphql.schema';

@Injectable()
export class PlatformGraphqlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
    private readonly orders: OrdersService,
    private readonly platform: PlatformService,
  ) {}

  async run(
    source: string,
    variableValues: Record<string, unknown> | undefined,
    user: SessionUser,
  ) {
    const result = await graphql({
      schema: platformSchema,
      source,
      variableValues,
      rootValue: {
        menu: async ({ branchId }: { branchId: string }) => {
          await this.access.assertAccess(user.restaurantId, branchId);
          const rows = await this.prisma.menuItem.findMany({
            where: { branchId, isActive: true },
            take: 100,
            orderBy: { name: 'asc' },
            select: { id: true, name: true, price: true },
          });
          return rows.map((row) => ({
            id: row.id,
            name: row.name,
            price: row.price.toString(),
          }));
        },
        openOrders: async ({ branchId }: { branchId: string }) => {
          await this.access.assertAccess(user.restaurantId, branchId);
          const rows = await this.prisma.order.findMany({
            where: { branchId, status: 'OPEN' },
            take: 50,
            orderBy: { createdAt: 'desc' },
            select: { id: true, orderNumber: true, status: true, totalAmount: true },
          });
          return rows.map((row) => ({
            id: row.id,
            number: row.orderNumber,
            status: row.status,
            total: row.totalAmount.toString(),
          }));
        },
        customer: async ({ branchId, id }: { branchId: string; id: string }) => {
          await this.access.assertAccess(user.restaurantId, branchId);
          const row = await this.prisma.customer.findFirst({
            where: { id, branchId },
            select: { id: true, name: true, phone: true },
          });
          return row;
        },
        scoreboard: () => this.platform.scoreboard(user.restaurantId),
        devices: async ({ branchId }: { branchId: string }) => {
          await this.access.assertAccess(user.restaurantId, branchId);
          const rows = await this.platform.devices(branchId);
          return rows.map((row) => ({
            id: row.id,
            name: row.name,
            online: row.online,
            version: row.appVersion,
            lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
          }));
        },
        recallTicket: async ({ branchId, kotId }: { branchId: string; kotId: string }) => {
          await this.access.assertAccess(user.restaurantId, branchId);
          await this.orders.updateKotStatus(branchId, kotId, 'PREPARING', user.id);
          return true;
        },
      },
    });
    return {
      data: result.data,
      errors: result.errors?.map((error: GraphQLError) => error.message) ?? [],
    };
  }
}
