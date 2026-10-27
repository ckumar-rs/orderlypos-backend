/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped by design */
// Regression: an existing staff member logs in and gets exactly the branch
// they were assigned - never none (the "No branches available" report), never
// someone else's. Opt-in:
//   BRANCHES_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand branches
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

const run = process.env.BRANCHES_E2E ? describe : describe.skip;
const tag = randomUUID().slice(0, 6);

run('Branch list per login (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let secondBranchId: string;

  const loginAs = async (email: string) => {
    const a = request.agent(app.getHttpServer());
    await a
      .post('/api/v1/auth/login')
      .send({ email, password: 'Password123!' })
      .expect(201);
    return a;
  };
  const branchNames = async (a: ReturnType<typeof request.agent>) => {
    const res = await a.get('/api/v1/branches').expect(200);
    return (res.body as { id: string }[]).map((b) => b.id).sort();
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 1,
            timeToExpire: 60,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();
    prisma = app.get(PrismaService);

    owner = await loginAs('owner@demo.local');
    const demo = await prisma.branch.findUniqueOrThrow({
      where: { id: 'demo-branch' },
    });
    const second = await prisma.branch.create({
      data: {
        restaurantId: demo.restaurantId,
        name: `Second ${tag}`,
        address: 'x',
      },
    });
    secondBranchId = second.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const createStaff = async (
    role: string,
    suffix: string,
    branchIds: string[],
  ) => {
    const roles = (await owner.get('/api/v1/users/roles').expect(200)).body as {
      id: string;
      name: string;
    }[];
    const email = `${suffix}-${tag}@demo.local`;
    await owner
      .post('/api/v1/users')
      .send({
        name: `${suffix} ${tag}`,
        email,
        password: 'Password123!',
        roleId: roles.find((r) => r.name === role)!.id,
        branchIds,
      })
      .expect(201);
    return email;
  };

  it('an existing waiter logs in and loads their assigned branch', async () => {
    const email = await createStaff('WAITER', 'waiter', ['demo-branch']);
    // A fresh login, as a returning staff member would do.
    const waiter = await loginAs(email);
    expect(await branchNames(waiter)).toEqual(['demo-branch']);
  });

  it('staff only see the branches they are assigned to', async () => {
    const cashier = await loginAs(
      await createStaff('CASHIER', 'cashier', [secondBranchId]),
    );
    expect(await branchNames(cashier)).toEqual([secondBranchId]);

    const both = await loginAs(
      await createStaff('RESTAURANT_MANAGER', 'manager', [
        'demo-branch',
        secondBranchId,
      ]),
    );
    expect(await branchNames(both)).toEqual(
      ['demo-branch', secondBranchId].sort(),
    );
  });

  it('owner and administrator see every branch of the restaurant', async () => {
    const all = await branchNames(owner);
    expect(all).toEqual(
      expect.arrayContaining(['demo-branch', secondBranchId]),
    );
    const admin = await loginAs(
      await createStaff('ADMINISTRATOR', 'admin', ['demo-branch']),
    );
    expect(await branchNames(admin)).toEqual(all);
  });

  it('a branch from another restaurant is never listed', async () => {
    const other = await prisma.restaurant.create({
      data: { name: `Other ${tag}` } as never,
    });
    const foreign = await prisma.branch.create({
      data: { restaurantId: other.id, name: `Foreign ${tag}`, address: 'x' },
    });
    expect(await branchNames(owner)).not.toContain(foreign.id);
  });

  it('a signed-out request is an auth error, not an empty list', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/branches');
    expect(res.status).toBe(401);
  });
});
