/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { AccountingService } from './accounting.service';

// Guards the bug where report windows were cut at UTC midnight instead of
// the restaurant's local midnight.
describe('AccountingService day windows', () => {
  function setup() {
    const prisma = {
      payment: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
      refund: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
      expense: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
    };
    const time = { tzForBranch: jest.fn().mockResolvedValue('Asia/Kolkata') };
    return {
      svc: new AccountingService(prisma as never, time as never, {} as never),
      prisma,
    };
  }

  it('cuts the cash-close window at local (IST) midnight', async () => {
    const { svc, prisma } = setup();
    await svc.closingPreview('b1', '2026-10-04');
    const range = prisma.payment.aggregate.mock.calls[0][0].where.createdAt;
    expect(range.gte.toISOString()).toBe('2026-10-03T18:30:00.000Z');
    expect(range.lt.toISOString()).toBe('2026-10-04T18:30:00.000Z');
    expect(prisma.refund.aggregate.mock.calls[0][0].where.createdAt).toEqual(
      range,
    );
  });
});
