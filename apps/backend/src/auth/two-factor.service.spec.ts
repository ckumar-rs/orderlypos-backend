/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { UnauthorizedException } from '@nestjs/common';
import { base32Decode, generateSecret, hotp, sealSecret, stepAt } from './totp';
import { TwoFactorService } from './two-factor.service';

const KEY = 'unit-test-key';

function setup(lastStep: number | null = null, updateCount = 1) {
  const secret = generateSecret();
  const user = {
    id: 'u1',
    twoFactorEnabled: true,
    twoFactorSecret: sealSecret(secret, KEY),
    twoFactorRecoveryHashes: [] as string[],
    twoFactorLastStep: lastStep,
  };
  const prisma = {
    user: { updateMany: jest.fn().mockResolvedValue({ count: updateCount }) },
  };
  const config = {
    get: (k: string) => (k === 'TWO_FACTOR_KEY' ? KEY : undefined),
    getOrThrow: () => KEY,
  };
  const svc = new TwoFactorService(
    prisma as never,
    config as never,
    { record: jest.fn() } as never,
  );
  const codeAt = (offset = 0) =>
    hotp(base32Decode(secret), stepAt(Date.now()) + offset);
  return { svc, user, prisma, codeAt };
}

describe('TwoFactorService.verifyLogin', () => {
  it('accepts a valid code and records its step', async () => {
    const { svc, user, prisma, codeAt } = setup();
    await expect(svc.verifyLogin(user, codeAt())).resolves.toBeUndefined();
    expect(prisma.user.updateMany.mock.calls[0][0].data.twoFactorLastStep).toBe(
      stepAt(Date.now()),
    );
  });

  it('asks for a code when none is given', async () => {
    const { svc, user } = setup();
    await expect(svc.verifyLogin(user, undefined)).rejects.toThrow(
      'TWO_FACTOR_REQUIRED',
    );
  });

  it('rejects a code from a step already used (replay)', async () => {
    const { svc, user, codeAt } = setup(stepAt(Date.now()));
    await expect(svc.verifyLogin(user, codeAt())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when a concurrent request already consumed the step', async () => {
    const { svc, user, codeAt } = setup(null, 0); // updateMany matched nothing
    await expect(svc.verifyLogin(user, codeAt())).rejects.toThrow(
      'Invalid verification code',
    );
  });

  it('locks the account after 5 wrong codes, even for a right one', async () => {
    const { svc, user, codeAt } = setup();
    for (let i = 0; i < 5; i++) {
      await expect(svc.verifyLogin(user, '000000')).rejects.toThrow(
        'Invalid verification code',
      );
    }
    await expect(svc.verifyLogin(user, codeAt())).rejects.toThrow(/Too many/);
  });
});
