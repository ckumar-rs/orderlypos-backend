// Role-permission policy end-to-end against a REAL, migrated + seeded Postgres.
//   PERMISSIONS_E2E=1 DATABASE_URL=... JWT_SECRET=x npm run test:e2e -- permissions
// Creates one throw-away staff login per role under the seeded demo restaurant.
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const run = process.env.PERMISSIONS_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const q = `?branchId=${BRANCH}`;
const tag = randomUUID().slice(0, 6);
const ROLES = [
  'WAITER',
  'KITCHEN_STAFF',
  'CHEF',
  'BARTENDER',
  'DELIVERY_STAFF',
  'INVENTORY_MANAGER',
  'ACCOUNTANT',
  'CASHIER',
  'RESTAURANT_MANAGER',
];

run('Role permissions (e2e)', () => {
  let app: INestApplication<App>;
  const agents: Record<string, ReturnType<typeof request.agent>> = {};

  beforeAll(async () => {
    // Ten logins in a row would trip the per-route login throttle.
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    })
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

    const owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);
    agents.OWNER = owner;
    const roles = (await owner.get('/api/v1/users/roles').expect(200)).body as {
      id: string;
      name: string;
    }[];
    for (const name of ROLES) {
      const role = roles.find((r) => r.name === name)!;
      const email = `${name.toLowerCase()}-${tag}@demo.local`;
      await owner
        .post('/api/v1/users')
        .send({
          name: `${name} ${tag}`,
          email,
          password: 'Password123!',
          roleId: role.id,
          branchIds: [BRANCH],
        })
        .expect(201);
      const agent = request.agent(app.getHttpServer());
      await agent
        .post('/api/v1/auth/login')
        .send({ email, password: 'Password123!' })
        .expect(201);
      agents[name] = agent;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const status = async (
    role: string,
    method: 'get' | 'post' | 'patch',
    path: string,
    body?: object,
  ) => (await agents[role][method](`/api/v1${path}`).send(body)).status;

  it('only owner/admin/accountant/cashier can read dashboard revenue and trends', async () => {
    for (const role of ['OWNER', 'ACCOUNTANT', 'CASHIER']) {
      expect(await status(role, 'get', `/dashboard/summary${q}`)).toBe(200);
      expect(await status(role, 'get', `/dashboard/trends${q}`)).toBe(200);
    }
    for (const role of [
      'WAITER',
      'KITCHEN_STAFF',
      'CHEF',
      'BARTENDER',
      'DELIVERY_STAFF',
      'INVENTORY_MANAGER',
      'RESTAURANT_MANAGER',
    ]) {
      expect(await status(role, 'get', `/dashboard/summary${q}`)).toBe(403);
      expect(await status(role, 'get', `/dashboard/trends${q}`)).toBe(403);
    }
  });

  it('hides sales reports from roles without dashboard.sales.view', async () => {
    expect(
      await status(
        'INVENTORY_MANAGER',
        'get',
        `/reports/sales-daily${q}&from=2026-01-01&to=2026-12-31`,
      ),
    ).toBe(403);
    expect(
      await status(
        'RESTAURANT_MANAGER',
        'get',
        `/reports/tax${q}&from=2026-01-01&to=2026-12-31`,
      ),
    ).toBe(403);
    expect(
      await status(
        'INVENTORY_MANAGER',
        'get',
        `/reports/waste${q}&from=2026-01-01&to=2026-12-31`,
      ),
    ).toBe(200);
    expect(
      await status(
        'ACCOUNTANT',
        'get',
        `/reports/sales-daily${q}&from=2026-01-01&to=2026-12-31`,
      ),
    ).toBe(200);
    const catalog = (
      await agents.INVENTORY_MANAGER.get('/api/v1/reports').expect(200)
    ).body as { key: string }[];
    expect(catalog.some((r) => r.key === 'sales-daily')).toBe(false);
    expect(catalog.some((r) => r.key === 'waste')).toBe(true);
  });

  it('waiter reads menu and tables but cannot edit them', async () => {
    expect(await status('WAITER', 'get', `/menu/categories${q}`)).toBe(200);
    expect(await status('WAITER', 'get', `/menu/items${q}`)).toBe(200);
    expect(await status('WAITER', 'get', `/tables/floors${q}`)).toBe(200);
    expect(
      await status('WAITER', 'post', `/menu/categories${q}`, { name: 'x' }),
    ).toBe(403);
    expect(
      await status('WAITER', 'post', `/tables/floors${q}`, { name: 'x' }),
    ).toBe(403);
    expect(await status('WAITER', 'patch', `/tables/layout${q}`, [])).toBe(403);
  });

  it('waiter keeps operational access: create an order and update a table status', async () => {
    const floors = (
      await agents.WAITER.get(`/api/v1/tables/floors${q}`).expect(200)
    ).body as { tables: { id: string }[] }[];
    const tableId = floors.flatMap((f) => f.tables)[0].id;
    expect(
      await status('WAITER', 'patch', `/tables/${tableId}/status${q}`, {
        status: 'CLEANING',
      }),
    ).toBe(200);
    expect(
      await status('WAITER', 'patch', `/tables/${tableId}/status${q}`, {
        status: 'AVAILABLE',
      }),
    ).toBe(200);
    const items = (
      await agents.WAITER.get(`/api/v1/menu/items${q}`).expect(200)
    ).body as { id: string }[];
    expect(
      await status('WAITER', 'post', `/orders${q}`, {
        type: 'TAKEAWAY',
        items: [
          {
            menuItemId: items.find((i) => i.id === 'demo-item-cola')!.id,
            quantity: 1,
          },
        ],
      }),
    ).toBe(201);
  });

  it('kitchen staff, delivery and inventory-only roles cannot read menu/tables via API', async () => {
    for (const role of ['KITCHEN_STAFF', 'INVENTORY_MANAGER']) {
      expect(await status(role, 'get', `/menu/categories${q}`)).toBe(403);
      expect(await status(role, 'get', `/tables/floors${q}`)).toBe(403);
    }
  });
});
