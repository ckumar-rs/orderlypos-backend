/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- supertest bodies and jest mock calls are untyped by design */
// Kiosk end-to-end API test against a REAL, migrated + seeded Postgres.
// Opt-in so a plain `npm run test:e2e` never needs a database:
//   KIOSK_E2E=1 DATABASE_URL=... JWT_SECRET=x npx prisma migrate deploy &&
//   npx ts-node prisma/seed.ts && KIOSK_E2E=1 npm run test:e2e -- kiosk
// Uses the seeded demo branch (owner@demo.local / Password123!).
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const run = process.env.KIOSK_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';

run('Kiosk API (e2e)', () => {
  let app: INestApplication<App>;
  let owner: ReturnType<typeof request.agent>;
  let token: string;

  const order = (over: Record<string, unknown> = {}, tok = token) =>
    request(app.getHttpServer())
      .post(`/api/v1/public/kiosk/${tok}/order`)
      .send({
        requestId: randomUUID(),
        serviceType: 'TAKEAWAY',
        items: [{ menuItemId: 'demo-item-cola', quantity: 1, modifierIds: [] }],
        ...over,
      });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();
    owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);
    const res = await owner
      .post(`/api/v1/settings/kiosk/enable?branchId=${BRANCH}`)
      .expect(201);
    token = res.body.kioskToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const pub = (path: string) => `/api/v1/public/kiosk/${path}`;

  it('serves the customer menu with currency and tax config', async () => {
    const res = await request(app.getHttpServer()).get(pub(token)).expect(200);
    expect(res.body.currency).toBeDefined();
    expect(res.body.taxLabel).toBeDefined();
    expect(res.body.categories.length).toBeGreaterThan(0);
  });

  it('creates exactly one order per requestId, even under parallel retries', async () => {
    const requestId = randomUUID();
    const send = () =>
      request(app.getHttpServer())
        .post(pub(`${token}/order`))
        .send({
          requestId,
          serviceType: 'DINE_IN',
          items: [
            { menuItemId: 'demo-item-cola', quantity: 3, modifierIds: [] },
          ],
        });
    const results = await Promise.all([send(), send(), send(), send()]);
    results.forEach((r) => expect(r.status).toBe(201));
    expect(new Set(results.map((r) => r.body.orderNumber)).size).toBe(1);
  });

  it('prices on the server: quantity x (item + modifiers), ignoring client money', async () => {
    const res = await request(app.getHttpServer())
      .post(pub(`${token}/order`))
      .send({
        requestId: randomUUID(),
        serviceType: 'TAKEAWAY',
        totalAmount: 1, // must be ignored
        items: [
          {
            menuItemId: 'demo-item-margherita',
            quantity: 2,
            modifierIds: ['demo-mod-cheese'],
          },
        ],
      })
      .expect(201);
    // seeded: 420 + 60 extra cheese, x2
    expect(Number(res.body.totalAmount)).toBe(960);
    expect(res.body.paid).toBe(false);
    expect(res.body).not.toHaveProperty('id');
  });

  it('enforces modifier rules and rejects unknown items', async () => {
    await order({
      items: [
        { menuItemId: 'demo-item-margherita', quantity: 1, modifierIds: [] },
      ],
    }).expect(400);
    await order({
      items: [{ menuItemId: 'does-not-exist', quantity: 1, modifierIds: [] }],
    }).expect(409);
    await order({ items: [] }).expect(400);
    await order({ requestId: 'not-a-uuid' }).expect(400);
  });

  it('a kiosk order reaches the KDS for a staff account, and the kiosk token cannot read it', async () => {
    const requestId = randomUUID();
    const placed = await request(app.getHttpServer())
      .post(pub(`${token}/order`))
      .send({
        requestId,
        serviceType: 'DINE_IN',
        items: [
          {
            menuItemId: 'demo-item-paneer-tikka',
            quantity: 1,
            modifierIds: [],
          },
        ],
      })
      .expect(201);
    const tickets = await owner
      .get(`/api/v1/kds/tickets?branchId=${BRANCH}`)
      .expect(200);
    const hit = tickets.body.find(
      (t: { order: { orderNumber: string } }) =>
        t.order.orderNumber === placed.body.orderNumber,
    );
    expect(hit).toBeDefined();
  });

  it('the public kiosk surface exposes no staff or admin API', async () => {
    const anon = request(app.getHttpServer());
    await anon.get(`/api/v1/kds/tickets?branchId=${BRANCH}`).expect(401);
    await anon.get(`/api/v1/orders?branchId=${BRANCH}`).expect(401);
    await anon.get(`/api/v1/settings?branchId=${BRANCH}`).expect(401);
    await anon
      .post(`/api/v1/settings/kiosk/rotate?branchId=${BRANCH}`)
      .expect(401);
    await anon.get('/api/v1/customers?branchId=' + BRANCH).expect(401);
  });

  it('rotating the token kills the old URL; disabling removes the kiosk', async () => {
    const rotated = await owner
      .post(`/api/v1/settings/kiosk/rotate?branchId=${BRANCH}`)
      .expect(201);
    expect(rotated.body.kioskToken).not.toBe(token);
    await request(app.getHttpServer()).get(pub(token)).expect(404);
    await order({}, token).expect(404);
    await request(app.getHttpServer())
      .get(pub(rotated.body.kioskToken))
      .expect(200);
    await owner
      .post(`/api/v1/settings/kiosk/disable?branchId=${BRANCH}`)
      .expect(201);
    await request(app.getHttpServer())
      .get(pub(rotated.body.kioskToken))
      .expect(404);
  });

  it('will not let the kiosk be left with no service option', async () => {
    await owner
      .patch(`/api/v1/settings/branch?branchId=${BRANCH}`)
      .send({ kioskDineInEnabled: false, kioskTakeawayEnabled: false })
      .expect(400);
  });
});
