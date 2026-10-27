import type { Prisma } from '@prisma/client';
import { pickTable } from './reservation-plan';

type Db = Prisma.TransactionClient | {
  table: Prisma.TransactionClient['table'];
  reservation: Prisma.TransactionClient['reservation'];
};

export async function suggestTable(
  db: Db,
  branchId: string,
  guests: number,
  start: Date,
  durationMinutes: number,
  area?: string | null,
  ignoreReservationId?: string,
) {
  const [tables, holds] = await Promise.all([
    db.table.findMany({
      where: { floor: { branchId } },
      select: {
        id: true,
        capacity: true,
        status: true,
        floor: { select: { name: true, seating: true } },
      },
    }),
    db.reservation.findMany({
      where: {
        branchId,
        status: { in: ['RESERVED', 'CONFIRMED', 'ARRIVED'] },
        tableId: { not: null },
      },
      select: {
        id: true,
        tableId: true,
        reservedAt: true,
        durationMinutes: true,
        status: true,
      },
    }),
  ]);
  return pickTable({
    guests,
    start,
    durationMinutes,
    area,
    now: new Date(),
    ignoreReservationId,
    tables: tables.map((table) => ({
      id: table.id,
      capacity: table.capacity,
      floorName: table.floor.name,
      seating: table.floor.seating,
      status: table.status,
    })),
    holds,
  });
}
