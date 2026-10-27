/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped by design */
// Sales -> inventory end-to-end test against a REAL, migrated + seeded Postgres.
// Opt-in (needs a database):
//   INVENTORY_E2E=1 DATABASE_URL=... JWT_SECRET=x npm run test:e2e -- inventory-stock
// Uses the seeded demo branch (owner@demo.local / Password123!) and creates its
// own uniquely named stock items and menu items, so it can be re-run.
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const run = process.env.INVENTORY_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const q = `?branchId=${BRANCH}`;
const tag = randomUUID().slice(0, 6);

run('Sales drive inventory (e2e)', () => {
  let app: INestApplication<App>;
  let owner: ReturnType<typeof request.agent>;
  let categoryId: string;
  const id: Record<string, string> = {};

  const stockOf = async (ingredientId: string) => {
    const res = await owner
      .get(`/api/v1/inventory/ingredients/${ingredientId}${q}`)
      .expect(200);
    return Number(res.body.currentStock);
  };
  const movements = async (ingredientId: string) =>
    (
      await owner
        .get(`/api/v1/inventory/ingredients/${ingredientId}/movements${q}`)
        .expect(200)
    ).body as { type: string; quantity: string; orderId: string | null }[];

  const ingredient = async (name: string, qty: number) => {
    const res = await owner
      .post(`/api/v1/inventory/ingredients${q}`)
      .send({ name: `${name}-${tag}`, unit: 'PIECE' })
      .expect(201);
    await owner
      .post(`/api/v1/inventory/ingredients/${res.body.id}/adjust${q}`)
      .send({ quantity: qty, note: 'e2e opening stock' })
      .expect(201);
    return res.body.id as string;
  };
  const menuItem = async (name: string) => {
    const res = await owner
      .post(`/api/v1/menu/items${q}`)
      .send({
        categoryId,
        name: `${name}-${tag}`,
        price: 100,
        taxRatePercent: 0,
      })
      .expect(201);
    return res.body.id as string;
  };
  const newOrder = async (
    items: { menuItemId: string; quantity: number }[],
  ) => {
    const res = await owner.post(`/api/v1/orders${q}`).send({
      type: 'TAKEAWAY',
      items: items.map((i) => ({ ...i, modifierIds: [] })),
    });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body as {
      id: string;
      totalAmount: string;
      items: { id: string; menuItemId: string }[];
    };
  };
  const pay = (order: { id: string; totalAmount: string }) =>
    owner.post(`/api/v1/orders/${order.id}/checkout${q}`).send({
      payments: [{ method: 'CASH', amount: Number(order.totalAmount) }],
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
    const cats = await owner.get(`/api/v1/menu/categories${q}`).expect(200);
    categoryId = cats.body[0].id;

    id.flour = await ingredient('flour', 100);
    id.cola = await ingredient('cola', 50);
    id.bun = await ingredient('bun', 50);
    id.recipe = await menuItem('RecipeItem');
    id.direct = await menuItem('DirectItem');
    id.plain = await menuItem('PlainItem');
    id.combo = await menuItem('ComboItem');
    id.burger = await menuItem('Burger');
    id.unmapped = await menuItem('Unmapped');

    await owner
      .patch(`/api/v1/inventory/menu-items/${id.recipe}/recipe${q}`)
      .send({ lines: [{ ingredientId: id.flour, quantity: 2 }] })
      .expect(200);
    await owner
      .patch(`/api/v1/inventory/menu-items/${id.direct}/tracking${q}`)
      .send({
        inventoryTracking: 'DIRECT',
        stockIngredientId: id.cola,
        stockQuantityPerSale: 1,
      })
      .expect(200);
    await owner
      .patch(`/api/v1/inventory/menu-items/${id.burger}/recipe${q}`)
      .send({ lines: [{ ingredientId: id.bun, quantity: 1 }] })
      .expect(200);
    await owner
      .post(`/api/v1/menu/items/${id.combo}/combo-components${q}`)
      .send({
        components: [
          { componentItemId: id.burger, quantity: 1 },
          { componentItemId: id.direct, quantity: 2 },
        ],
      })
      .expect(201);
    await owner
      .patch(`/api/v1/inventory/menu-items/${id.unmapped}/tracking${q}`)
      .send({ inventoryTracking: 'RECIPE' })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not touch stock while the order is only open, and deducts once when paid', async () => {
    const order = await newOrder([
      { menuItemId: id.recipe, quantity: 3 },
      { menuItemId: id.direct, quantity: 4 },
      { menuItemId: id.plain, quantity: 5 },
    ]);
    expect(await stockOf(id.flour)).toBe(100);
    expect(await stockOf(id.cola)).toBe(50);

    await pay(order).expect(201);
    expect(await stockOf(id.flour)).toBe(94); // 3 x 2
    expect(await stockOf(id.cola)).toBe(46); // 4 x 1, direct, no recipe

    const consumption = (await movements(id.flour)).filter(
      (m) => m.type === 'CONSUMPTION' && m.orderId === order.id,
    );
    expect(consumption).toHaveLength(1);
  });

  it('rejects a repeated checkout and never deducts twice, even in parallel', async () => {
    const order = await newOrder([{ menuItemId: id.recipe, quantity: 1 }]);
    const results = await Promise.all([pay(order), pay(order), pay(order)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await stockOf(id.flour)).toBe(92);
    await pay(order).expect(400);
    expect(await stockOf(id.flour)).toBe(92);
  });

  it('leaves stock alone when an unpaid order is cancelled', async () => {
    const before = await stockOf(id.flour);
    const order = await newOrder([{ menuItemId: id.recipe, quantity: 7 }]);
    await owner.post(`/api/v1/orders/${order.id}/cancel${q}`).expect(201);
    expect(await stockOf(id.flour)).toBe(before);
    await pay(order).expect(400);
    expect(await stockOf(id.flour)).toBe(before);
  });

  it('expands combos into component recipe and direct stock', async () => {
    const bun = await stockOf(id.bun);
    const cola = await stockOf(id.cola);
    const order = await newOrder([{ menuItemId: id.combo, quantity: 2 }]);
    await pay(order).expect(201);
    expect(await stockOf(id.bun)).toBe(bun - 2); // 2 combos x 1 burger
    expect(await stockOf(id.cola)).toBe(cola - 4); // 2 combos x 2 colas
  });

  it('deducts for a kiosk order only once staff take payment', async () => {
    const settings = await owner
      .post(`/api/v1/settings/kiosk/enable${q}`)
      .expect(201);
    const before = await stockOf(id.cola);
    const placed = await request(app.getHttpServer())
      .post(`/api/v1/public/kiosk/${settings.body.kioskToken}/order`)
      .send({
        requestId: randomUUID(),
        serviceType: 'TAKEAWAY',
        items: [{ menuItemId: id.direct, quantity: 2, modifierIds: [] }],
      })
      .expect(201);
    expect(await stockOf(id.cola)).toBe(before); // unpaid kiosk order
    const list = await owner.get(`/api/v1/orders${q}`).expect(200);
    const kiosk = list.body.find(
      (o: { orderNumber: string }) => o.orderNumber === placed.body.orderNumber,
    );
    expect(kiosk).toBeDefined();
    await pay(kiosk).expect(201);
    expect(await stockOf(id.cola)).toBe(before - 2);
  });

  it('flags tracked items that have no recipe/stock mapping and still completes the sale', async () => {
    const status = await owner
      .get(`/api/v1/inventory/tracking-status${q}`)
      .expect(200);
    expect(
      status.body.problems.some(
        (p: { menuItemId: string; reason: string }) =>
          p.menuItemId === id.unmapped && p.reason === 'NO_RECIPE',
      ),
    ).toBe(true);

    const order = await newOrder([{ menuItemId: id.unmapped, quantity: 1 }]);
    await pay(order).expect(201);
  });

  it('keeps stock on a money-only refund; restores only the units named as returned, once', async () => {
    const order = await newOrder([{ menuItemId: id.recipe, quantity: 4 }]);
    await pay(order).expect(201);
    const afterSale = await stockOf(id.flour);

    await owner
      .post(`/api/v1/orders/${order.id}/refund${q}`)
      .send({ amount: 100, method: 'CASH', reason: 'goodwill' })
      .expect(201);
    expect(await stockOf(id.flour)).toBe(afterSale); // no restock

    const lineId = order.items[0].id;
    await owner
      .post(`/api/v1/orders/${order.id}/refund${q}`)
      .send({
        amount: 100,
        method: 'CASH',
        returnedItems: [{ orderItemId: lineId, quantity: 1 }],
      })
      .expect(201);
    expect(await stockOf(id.flour)).toBe(afterSale + 2); // 1 unit x recipe 2

    const reversal = (await movements(id.flour)).filter(
      (m) => m.type === 'REVERSAL' && m.orderId === order.id,
    );
    expect(reversal).toHaveLength(1);
    expect(Number(reversal[0].quantity)).toBe(2);
    // original consumption row is untouched
    expect(
      (await movements(id.flour)).some(
        (m) =>
          m.type === 'CONSUMPTION' &&
          m.orderId === order.id &&
          Number(m.quantity) === -8,
      ),
    ).toBe(true);

    // 4 sold, 1 returned -> 3 left; 4 more is over the cap
    await owner
      .post(`/api/v1/orders/${order.id}/refund${q}`)
      .send({
        amount: 10,
        method: 'CASH',
        returnedItems: [{ orderItemId: lineId, quantity: 4 }],
      })
      .expect(400);
    expect(await stockOf(id.flour)).toBe(afterSale + 2);
  });
});
