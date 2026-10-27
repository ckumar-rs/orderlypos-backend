import type { Prisma } from '@prisma/client';
import { planConsume, planExpiry } from './loyalty';

export async function dropExpiredPoints(
  tx: Prisma.TransactionClient,
  customerId: string,
  now = new Date(),
) {
  const lots = await tx.pointLot.findMany({
    where: { customerId, pointsRemaining: { gt: 0 } },
    select: { id: true, pointsRemaining: true, expiresAt: true },
  });
  const plan = planExpiry(lots, now);
  if (plan.points <= 0) return 0;
  await tx.pointLot.updateMany({
    where: { id: { in: plan.lotIds } },
    data: { pointsRemaining: 0 },
  });
  const guest = await tx.customer.findUnique({
    where: { id: customerId },
    select: { loyaltyPoints: true },
  });
  if (!guest) return 0;
  const drop = Math.min(guest.loyaltyPoints, plan.points);
  if (drop > 0) {
    await tx.customer.update({
      where: { id: customerId },
      data: { loyaltyPoints: { decrement: drop } },
    });
  }
  return drop;
}

export async function consumePointLots(
  tx: Prisma.TransactionClient,
  customerId: string,
  points: number,
  now = new Date(),
) {
  if (points <= 0) return;
  const lots = await tx.pointLot.findMany({
    where: { customerId, pointsRemaining: { gt: 0 } },
    select: { id: true, pointsRemaining: true, expiresAt: true, createdAt: true },
  });
  const plan = planConsume(lots, points, now);
  for (const take of plan.takes) {
    await tx.pointLot.update({
      where: { id: take.id },
      data: { pointsRemaining: { decrement: take.take } },
    });
  }
}
