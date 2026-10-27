import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

function digits(phone: string | null | undefined) {
  return (phone ?? '').replace(/\D/g, '');
}

/** Records an advance or a charge on the guest's house account. A charge the account cannot hold is refused. */
export async function postHouseLedger(
  prisma: PrismaService,
  branchId: string,
  userId: string,
  input: {
    name: string;
    phone?: string | null;
    kind: 'ADVANCE' | 'CHARGE';
    amount: number;
    reference: string;
    reservationId?: string;
  },
) {
  const amount = Math.abs(input.amount);
  if (!(amount > 0)) return null;
  const phone = digits(input.phone);
  const accounts = await prisma.houseAccount.findMany({
    where: { branchId },
    include: { customer: { select: { id: true, phone: true } } },
  });
  let account = phone
    ? accounts.find((row) => digits(row.customer?.phone) === phone)
    : accounts.find((row) => row.name === input.name);
  if (!account) {
    const customers = phone
      ? await prisma.customer.findMany({ where: { branchId }, select: { id: true, phone: true } })
      : [];
    const customerId = customers.find((row) => digits(row.phone) === phone)?.id;
    account = await prisma.houseAccount.create({
      data: {
        branchId,
        name: input.name.trim() || 'Guest',
        customerId,
        creditLimit: input.kind === 'CHARGE' ? amount : 0,
      },
      include: { customer: { select: { id: true, phone: true } } },
    });
  }
  const signed = input.kind === 'CHARGE' ? -amount : amount;
  const next = Math.round((Number(account.balance) + signed) * 100) / 100;
  if (next < -Number(account.creditLimit)) {
    throw new BadRequestException('This would exceed the house credit limit');
  }
  await prisma.houseAccount.update({ where: { id: account.id }, data: { balance: next } });
  await prisma.houseAccountEntry.create({
    data: {
      houseAccountId: account.id,
      kind: input.kind,
      amount: signed,
      reference: input.reference,
      reservationId: input.reservationId,
      createdById: userId,
    },
  });
  return { houseAccountId: account.id, balance: next };
}
