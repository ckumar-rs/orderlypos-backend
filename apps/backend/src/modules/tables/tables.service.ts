import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BulkTableCreateDto,
  FloorDto,
  FloorUpdateDto,
  TableDto,
  TableLayoutUpdateDto,
  TableStatusDto,
  TableUpdateDto,
} from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { snapToGrid } from '../kds/kot-rollup';

@Injectable()
export class TablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  listFloors(branchId: string) {
    return this.prisma.floor.findMany({
      where: { branchId },
      orderBy: { sortOrder: 'asc' },
      include: {
        tables: {
          include: { assignedWaiter: { select: { id: true, name: true } } },
        },
      },
    });
  }

  createFloor(branchId: string, dto: FloorDto) {
    return this.prisma.floor.create({ data: { ...dto, branchId } });
  }

  async updateFloor(branchId: string, id: string, dto: FloorUpdateDto) {
    await this.assertFloorInBranch(branchId, id);
    return this.prisma.floor.update({ where: { id }, data: dto });
  }

  async createTable(branchId: string, dto: TableDto) {
    await this.assertFloorInBranch(branchId, dto.floorId);
    const table = await this.prisma.table.create({ data: dto });
    this.realtime.emitToBranch(branchId, 'table.updated', table);
    return table;
  }

  async createTables(branchId: string, dto: BulkTableCreateDto) {
    await this.assertFloorInBranch(branchId, dto.floorId);

    const numbers = dto.numbers.map((n) => n.trim()).filter(Boolean);
    const duplicatesInBatch = numbers.filter(
      (n, i) => numbers.indexOf(n) !== i,
    );
    if (duplicatesInBatch.length > 0) {
      throw new BadRequestException(
        `Table numbers must be unique: ${[...new Set(duplicatesInBatch)].join(', ')} ${duplicatesInBatch.length > 1 ? 'are' : 'is'} repeated.`,
      );
    }

    const existing = await this.prisma.table.findMany({
      where: { floorId: dto.floorId, number: { in: numbers } },
      select: { number: true },
    });
    if (existing.length > 0) {
      const clashes = existing.map((t) => t.number).join(', ');
      throw new BadRequestException(
        `These table numbers already exist on this floor: ${clashes}. Choose different numbers.`,
      );
    }

    const tables = await this.prisma.$transaction(
      numbers.map((number, index) =>
        this.prisma.table.create({
          data: {
            floorId: dto.floorId,
            number,
            capacity: dto.capacity,
            shape: dto.shape,
            color: dto.color,
            posX: 20 + (index % 5) * 100,
            posY: 20 + Math.floor(index / 5) * 100,
          },
        }),
      ),
    );
    tables.forEach((table) =>
      this.realtime.emitToBranch(branchId, 'table.updated', table),
    );
    return tables;
  }

  async updateTable(branchId: string, id: string, dto: TableUpdateDto) {
    await this.assertTableInBranch(branchId, id);
    const table = await this.prisma.table.update({ where: { id }, data: dto });
    this.realtime.emitToBranch(branchId, 'table.updated', table);
    return table;
  }

  async updateTableLayout(branchId: string, updates: TableLayoutUpdateDto[]) {
    const owned = await this.prisma.table.findMany({
      where: { id: { in: updates.map((u) => u.id) }, floor: { branchId } },
      select: { id: true, floor: { select: { gridSize: true } } },
    });
    if (owned.length !== updates.length) {
      throw new BadRequestException(
        'One or more tables are invalid for this branch',
      );
    }
    const gridByTable = new Map(owned.map((row) => [row.id, row.floor.gridSize]));

    const results = await this.prisma.$transaction(
      updates.map(({ id, posX, posY, width, height, rotation }) => {
        const grid = gridByTable.get(id) ?? 0;
        return this.prisma.table.update({
          where: { id },
          data: {
            posX: snapToGrid(posX, grid),
            posY: snapToGrid(posY, grid),
            width: Math.max(grid || 40, snapToGrid(width, grid) || width),
            height: Math.max(grid || 40, snapToGrid(height, grid) || height),
            rotation,
          },
        });
      }),
    );
    this.realtime.emitToBranch(branchId, 'table.layout.updated', results);
    return results;
  }

  async updateTableStatus(
    branchId: string,
    id: string,
    status: TableStatusDto,
    assignedWaiterId?: string,
  ) {
    await this.assertTableInBranch(branchId, id);
    // A table with an unpaid bill cannot be marked free/reserved/cleaning by
    // hand - that is how a live order ended up hidden behind an "Available"
    // tile. Pay or cancel the bill first (both release the table themselves).
    if (status !== 'OCCUPIED') {
      const open = await this.prisma.order.findFirst({
        where: { tableId: id, status: 'OPEN' },
        select: { orderNumber: true },
      });
      if (open) {
        throw new ConflictException(
          `This table has an open bill (#${open.orderNumber}) - pay or cancel it first`,
        );
      }
    }
    const table = await this.prisma.table.update({
      where: { id },
      data: {
        status,
        statusSince: new Date(),
        ...(assignedWaiterId ? { assignedWaiterId } : {}),
      },
    });
    this.realtime.emitToBranch(branchId, 'table.updated', table);
    return table;
  }

  async deleteTable(branchId: string, id: string) {
    await this.assertTableInBranch(branchId, id);
    await this.prisma.table.delete({ where: { id } });
    this.realtime.emitToBranch(branchId, 'table.deleted', { id });
    return { ok: true };
  }

  async rotateQrToken(branchId: string, id: string) {
    const table = await this.prisma.table.findFirst({
      where: { id, floor: { branchId } },
    });
    if (!table) throw new NotFoundException('Table not found');

    // opaque, unguessable token — not the table's own id, so a leaked QR
    // image can't be used to enumerate other tables' ids/data
    const qrToken = randomBytes(16).toString('hex');
    return this.prisma.table.update({ where: { id }, data: { qrToken } });
  }

  private async assertFloorInBranch(branchId: string, floorId: string) {
    const floor = await this.prisma.floor.findFirst({
      where: { id: floorId, branchId },
    });
    if (!floor) throw new NotFoundException('Floor not found');
  }

  private async assertTableInBranch(branchId: string, tableId: string) {
    const table = await this.prisma.table.findFirst({
      where: { id: tableId, floor: { branchId } },
    });
    if (!table) throw new NotFoundException('Table not found');
  }

  /** Open guest requests (call waiter / bring bill) for a branch. */
  listOpenRequests(branchId: string) {
    return this.prisma.tableRequest.findMany({
      where: { branchId, resolvedAt: null },
      include: { table: { select: { id: true, number: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async resolveRequest(branchId: string, id: string) {
    const request = await this.prisma.tableRequest.findFirst({
      where: { id, branchId },
    });
    if (!request) throw new NotFoundException('Request not found');
    const updated = await this.prisma.tableRequest.update({
      where: { id },
      data: { resolvedAt: new Date() },
    });
    this.realtime.emitToBranch(branchId, 'table.request', { id });
    return updated;
  }

  async analytics(branchId: string, from?: string, to?: string) {
    const end = to ? new Date(`${to}T23:59:59.999`) : new Date();
    const start = from
      ? new Date(`${from}T00:00:00.000`)
      : new Date(end.getTime() - 7 * 86_400_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Use dates as YYYY-MM-DD');
    }
    const tables = await this.prisma.table.findMany({
      where: { floor: { branchId } },
      select: { id: true, number: true, name: true, capacity: true },
      orderBy: { number: 'asc' },
    });
    const orders = await this.prisma.order.findMany({
      where: {
        branchId,
        status: 'PAID',
        tableId: { not: null },
        billedAt: { gte: start, lte: end },
      },
      select: {
        tableId: true,
        totalAmount: true,
        createdAt: true,
        billedAt: true,
      },
    });
    const days = Math.max(1, (end.getTime() - start.getTime()) / 86_400_000);
    const rows = tables.map((table) => {
      const paid = orders.filter((order) => order.tableId === table.id);
      const revenue = paid.reduce((sum, order) => sum + Number(order.totalAmount), 0);
      const minutes = paid
        .filter((order) => order.billedAt)
        .map(
          (order) =>
            (order.billedAt!.getTime() - order.createdAt.getTime()) / 60_000,
        );
      const avgMinutes = minutes.length
        ? minutes.reduce((sum, value) => sum + value, 0) / minutes.length
        : 0;
      return {
        tableId: table.id,
        number: table.number,
        name: table.name,
        capacity: table.capacity,
        paidOrders: paid.length,
        revenue: Math.round(revenue * 100) / 100,
        avgMinutes: Math.round(avgMinutes * 10) / 10,
        turnover: Math.round((paid.length / days) * 100) / 100,
        revenuePerSeat: table.capacity
          ? Math.round((revenue / table.capacity) * 100) / 100
          : 0,
      };
    });
    const revenue = rows.reduce((sum, row) => sum + row.revenue, 0);
    const seats = tables.reduce((sum, table) => sum + table.capacity, 0);
    return {
      from: start.toISOString(),
      to: end.toISOString(),
      days: Math.round(days * 10) / 10,
      tables: rows,
      totals: {
        paidOrders: rows.reduce((sum, row) => sum + row.paidOrders, 0),
        revenue: Math.round(revenue * 100) / 100,
        avgMinutes:
          rows.reduce((sum, row) => sum + row.avgMinutes * row.paidOrders, 0) /
            Math.max(1, rows.reduce((sum, row) => sum + row.paidOrders, 0)) || 0,
        turnover:
          Math.round(
            (rows.reduce((sum, row) => sum + row.paidOrders, 0) / days) * 100,
          ) / 100,
        revenuePerSeat: seats ? Math.round((revenue / seats) * 100) / 100 : 0,
      },
    };
  }

  async history(branchId: string, tableId: string) {
    const table = await this.prisma.table.findFirst({
      where: { id: tableId, floor: { branchId } },
      select: { id: true, number: true, name: true },
    });
    if (!table) throw new NotFoundException('Table not found');
    const orders = await this.prisma.order.findMany({
      where: { branchId, tableId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        guestCount: true,
        guestName: true,
        partyName: true,
        totalAmount: true,
        createdAt: true,
        billedAt: true,
        customer: { select: { name: true } },
      },
    });
    return {
      table,
      bills: orders.map((order) => {
        const ended = order.billedAt;
        const durationMinutes = ended
          ? Math.max(0, Math.round((ended.getTime() - order.createdAt.getTime()) / 60000))
          : order.status === 'OPEN'
            ? Math.max(0, Math.round((Date.now() - order.createdAt.getTime()) / 60000))
            : null;
        return {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          guests: order.guestCount,
          guestName: order.guestName,
          partyName: order.partyName,
          customerName: order.customer?.name ?? null,
          revenue: Number(order.totalAmount),
          openedAt: order.createdAt,
          billedAt: order.billedAt,
          durationMinutes,
        };
      }),
    };
  }
}
