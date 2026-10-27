/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- supertest bodies are untyped by design */
// The order lifecycle end to end, against a REAL, migrated + seeded Postgres:
// incoming-order accept/decline, kitchen ticket state machine and rejection,
// print-bill-before-payment, part and split payments with change, discount
// display, role boundaries (Owner / Cashier / Waiter / Kitchen / Accountant)
// and the realtime events each step emits. Opt-in:
//   ORDER_FLOW_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand order-flow
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { OrdersService } from './../src/modules/orders/orders.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { RealtimeGateway } from './../src/realtime/realtime.gateway';

const run = process.env.ORDER_FLOW_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const q = `?branchId=${BRANCH}`;
const tag = randomUUID().slice(0, 6);
const ROLES = [
  'WAITER',
  'CASHIER',
  'KITCHEN_STAFF',
  'RESTAURANT_MANAGER',
  'ACCOUNTANT',
];

type Agent = ReturnType<typeof request.agent>;

run('Order flow: accept, kitchen, bill, payment, roles (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let orders: OrdersService;
  let ownerId: string;
  const events: { event: string; payload: any }[] = [];
  const agents: Record<string, Agent> = {};
  const tables: Record<string, string> = {};
  let menuItemId: string; // 100.00 incl. 18% tax
  let item2Id: string; // 50.00, no tax

  const call = (role: string) => ({
    get: (p: string) => agents[role].get(`/api/v1${p}`),
    post: (p: string, b?: object) => agents[role].post(`/api/v1${p}`).send(b),
    patch: (p: string, b?: object) => agents[role].patch(`/api/v1${p}`).send(b),
  });
  const owner = call('OWNER');
  const waiter = call('WAITER');
  const cashier = call('CASHIER');
  const kitchen = call('KITCHEN_STAFF');
  const manager = call('RESTAURANT_MANAGER');
  const accountant = call('ACCOUNTANT');

  const seen = (event: string, since = 0) =>
    events.slice(since).filter((e) => e.event === event);
  const mark = () => events.length;

  const newDineIn = async (
    tableId: string,
    items: object[] = [{ menuItemId, quantity: 2, modifierIds: [] }],
  ) => {
    const res = await waiter.post(`/orders${q}`, {
      type: 'DINE_IN',
      tableId,
      items,
    });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body;
  };
  const newOnline = async () => {
    const order = await orders.createOrder(
      BRANCH,
      ownerId,
      {
        type: 'TAKEAWAY',
        guestName: 'Web Guest',
        items: [{ menuItemId, quantity: 1, modifierIds: [] }],
      },
      { channel: 'ONLINE', requireAcceptance: true },
    );
    return order;
  };
  const detail = async (id: string) =>
    (await owner.get(`/orders/${id}${q}`).expect(200)).body;
  const tableStatus = async (id: string) => {
    const floors = (await owner.get(`/tables/floors${q}`).expect(200)).body;
    for (const f of floors)
      for (const t of f.tables) if (t.id === id) return t.status as string;
    throw new Error('table missing');
  };
  const advance = async (kotId: string, to: string[]) => {
    for (const status of to)
      await kitchen
        .patch(`/kds/tickets/${kotId}/status${q}`, { status })
        .expect(200);
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
    orders = app.get(OrdersService);

    // Record every realtime push so each step can assert what it broadcast.
    const gateway = app.get(RealtimeGateway);
    const emit = gateway.emitToBranch.bind(gateway);
    jest
      .spyOn(gateway, 'emitToBranch')
      .mockImplementation(
        (branchId: string, event: string, payload: unknown) => {
          events.push({ event, payload });
          emit(branchId, event, payload);
        },
      );

    const ownerAgent = request.agent(app.getHttpServer());
    await ownerAgent
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);
    agents.OWNER = ownerAgent;
    ownerId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'owner@demo.local' },
      })
    ).id;

    const roles = (await owner.get('/users/roles').expect(200)).body as {
      id: string;
      name: string;
    }[];
    for (const name of ROLES) {
      const email = `${name.toLowerCase()}-of-${tag}@demo.local`;
      await owner
        .post('/users', {
          name: `${name} ${tag}`,
          email,
          password: 'Password123!',
          roleId: roles.find((r) => r.name === name)!.id,
          branchIds: [BRANCH],
        })
        .expect(201);
      const a = request.agent(app.getHttpServer());
      await a
        .post('/api/v1/auth/login')
        .send({ email, password: 'Password123!' })
        .expect(201);
      agents[name] = a;
    }

    const floors = (await owner.get(`/tables/floors${q}`).expect(200)).body;
    for (const n of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
      const t = await owner
        .post(`/tables${q}`, {
          floorId: floors[0].id,
          number: `${n}-${tag}`,
          capacity: 4,
        })
        .expect(201);
      tables[n] = t.body.id;
    }
    const cats = (await owner.get(`/menu/categories${q}`).expect(200)).body;
    const mk = async (name: string, price: number, taxRatePercent: number) =>
      (
        await owner
          .post(`/menu/items${q}`, {
            categoryId: cats[0].id,
            name: `${name}-${tag}`,
            price,
            taxRatePercent,
          })
          .expect(201)
      ).body.id as string;
    menuItemId = await mk('Paneer', 100, 18);
    item2Id = await mk('Naan', 50, 0);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  // ------------------------------------------------------- incoming orders
  describe('incoming online orders', () => {
    it('waits for a decision: no kitchen ticket, not payable, visible to the kitchen', async () => {
      const order = await newOnline();
      expect(order.acceptance).toBe('PENDING');
      expect(order.kots).toHaveLength(0);

      const incoming = (await kitchen.get(`/kds/incoming${q}`).expect(200))
        .body;
      expect(incoming.map((o: any) => o.id)).toContain(order.id);
      const tickets = (await kitchen.get(`/kds/tickets${q}`).expect(200)).body;
      expect(tickets.some((t: any) => t.orderId === order.id)).toBe(false);

      // Accepting is separate from paying: it cannot be settled unaccepted.
      const pay = await cashier.post(`/orders/${order.id}/checkout${q}`, {
        payments: [{ method: 'CASH', amount: 118 }],
      });
      expect(pay.status).toBe(409);
      expect(pay.body.message).toMatch(/accept/i);
      expect((await detail(order.id)).status).toBe('OPEN');
    });

    it('is accepted once: the kitchen gets one ticket, a second accept is refused', async () => {
      const order = await newOnline();
      const m = mark();
      const ok = await kitchen.post(`/kds/incoming/${order.id}/accept${q}`);
      expect(ok.status).toBe(201);
      expect(ok.body.acceptance).toBe('ACCEPTED');
      expect(ok.body.acceptedById).toBeTruthy();
      expect(ok.body.kots).toHaveLength(1);
      expect(seen('kot.created', m)).toHaveLength(1);
      expect(seen('order.updated', m).length).toBeGreaterThan(0);

      const again = await cashier.post(`/orders/${order.id}/accept${q}`);
      expect(again.status).toBe(409);
      expect((await detail(order.id)).kots).toHaveLength(1);

      // Concurrent accepts: exactly one wins and exactly one ticket exists.
      const racy = await newOnline();
      const results = await Promise.all([
        kitchen.post(`/kds/incoming/${racy.id}/accept${q}`),
        cashier.post(`/orders/${racy.id}/accept${q}`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect((await detail(racy.id)).kots).toHaveLength(1);
    });

    it('is declined with a reason: the order is kept, marked declined, who/why recorded', async () => {
      const order = await newOnline();
      const noReason = await kitchen.post(
        `/kds/incoming/${order.id}/reject${q}`,
        {},
      );
      expect(noReason.status).toBe(400);

      const m = mark();
      const res = await kitchen.post(`/kds/incoming/${order.id}/reject${q}`, {
        reason: 'Closing early',
      });
      expect(res.status).toBe(201);
      const d = await detail(order.id); // the record still exists
      expect(d.status).toBe('CANCELLED');
      expect(d.acceptance).toBe('REJECTED');
      expect(d.cancelSource).toBe('ONLINE_DECLINED');
      expect(d.cancelReason).toBe('Closing early');
      expect(d.cancelledById).toBeTruthy();
      expect(d.kots).toHaveLength(0);
      expect(seen('order.updated', m)[0].payload.status).toBe('CANCELLED');

      const again = await kitchen.post(`/kds/incoming/${order.id}/reject${q}`, {
        reason: 'again',
      });
      expect(again.status).toBe(409);
      const audit = await prisma.auditLog.findFirst({
        where: {
          entity: 'Order',
          entityId: order.id,
          action: 'order.declined',
        },
      });
      expect(audit?.metadata).toMatchObject({
        source: 'ONLINE_DECLINED',
        reason: 'Closing early',
      });
    });

    it('can be answered by cashier / kitchen / waiter, not by accounting', async () => {
      for (const who of [cashier, waiter]) {
        const o = await newOnline();
        expect((await who.post(`/orders/${o.id}/accept${q}`)).status).toBe(201);
      }
      const o = await newOnline();
      expect((await accountant.post(`/orders/${o.id}/accept${q}`)).status).toBe(
        403,
      );
      expect(
        (await accountant.post(`/orders/${o.id}/reject${q}`, { reason: 'x' }))
          .status,
      ).toBe(403);
      expect((await accountant.get(`/kds/incoming${q}`)).status).toBe(403);
      expect((await detail(o.id)).acceptance).toBe('PENDING');
    });
  });

  // ------------------------------------------------------- kitchen tickets
  describe('kitchen ticket lifecycle', () => {
    it('a waiter orders, the kitchen sees it with notes, and progress is visible to the waiter', async () => {
      // Waiter can reach what they need.
      expect((await waiter.get(`/tables/floors${q}`)).status).toBe(200);
      expect((await waiter.get(`/menu/items${q}`)).status).toBe(200);
      const m = mark();
      const res = await waiter.post(`/orders${q}`, {
        type: 'DINE_IN',
        tableId: tables.A,
        notes: 'allergy: nuts',
        items: [
          { menuItemId, quantity: 2, modifierIds: [], kitchenNote: 'no onion' },
        ],
      });
      expect(res.status).toBe(201);
      expect(await tableStatus(tables.A)).toBe('OCCUPIED');
      expect(seen('order.created', m)).toHaveLength(1);
      expect(seen('kot.created', m)).toHaveLength(1);

      const ticket = (
        await kitchen.get(`/kds/tickets${q}`).expect(200)
      ).body.find((t: any) => t.orderId === res.body.id);
      expect(ticket.status).toBe('NEW');
      expect(ticket.order.notes).toBe('allergy: nuts');
      expect(ticket.items[0].orderItem.kitchenNote).toBe('no onion');
      expect(ticket.order.table.number).toBe(`A-${tag}`);

      // Waiter: progress yes (no contact details), the kitchen screen's API no.
      const progress = (await waiter.get(`/kds/progress${q}`).expect(200)).body;
      const mine = progress.find((p: any) => p.orderId === res.body.id);
      expect(mine.status).toBe('NEW');
      expect(mine.order.table.number).toBe(`A-${tag}`);
      expect(JSON.stringify(mine)).not.toMatch(/phone/);
      expect((await waiter.get(`/kds/tickets${q}`)).status).toBe(403);
      expect(
        (
          await waiter.patch(`/kds/tickets/${ticket.id}/status${q}`, {
            status: 'ACCEPTED',
          })
        ).status,
      ).toBe(403);
    });

    it('moves one valid step at a time and ignores a repeat', async () => {
      const order = await newDineIn(tables.B);
      const [kot] = order.kots;
      const skip = await kitchen.patch(`/kds/tickets/${kot.id}/status${q}`, {
        status: 'READY',
      });
      expect(skip.status).toBe(409);
      for (const bad of ['CANCELLED', 'REJECTED', 'NEW', 'bogus']) {
        expect(
          (
            await kitchen.patch(`/kds/tickets/${kot.id}/status${q}`, {
              status: bad,
            })
          ).status,
        ).toBe(400);
      }

      const m = mark();
      const first = await kitchen.patch(`/kds/tickets/${kot.id}/status${q}`, {
        status: 'ACCEPTED',
      });
      expect(first.status).toBe(200);
      expect(first.body.acceptedById).toBeTruthy();
      const acceptedAt = first.body.acceptedAt;
      expect(seen('kot.updated', m)).toHaveLength(1);

      // Double tap: harmless no-op, no second event, timestamp untouched.
      const dup = await kitchen.patch(`/kds/tickets/${kot.id}/status${q}`, {
        status: 'ACCEPTED',
      });
      expect(dup.status).toBe(200);
      expect(dup.body.acceptedAt).toBe(acceptedAt);
      expect(seen('kot.updated', m)).toHaveLength(1);

      // A stale screen asking for a step that is already behind us.
      await advance(kot.id, ['PREPARING', 'READY']);
      const stale = await kitchen.patch(`/kds/tickets/${kot.id}/status${q}`, {
        status: 'PREPARING',
      });
      expect(stale.status).toBe(409);
      await advance(kot.id, ['SERVED']);
      const afterServed = await kitchen.patch(
        `/kds/tickets/${kot.id}/status${q}`,
        { status: 'READY' },
      );
      expect(afterServed.status).toBe(409);
      expect((await detail(order.id)).kots[0].readyAt).toBeTruthy();
    });

    it('keeps live tickets after a refresh and drops only finished ones', async () => {
      const order = await newDineIn(tables.C);
      const [kot] = order.kots;
      await advance(kot.id, ['ACCEPTED', 'PREPARING']);
      // "Refresh": a brand-new request still finds the ticket where it was.
      const list = (await kitchen.get(`/kds/tickets${q}`).expect(200)).body;
      expect(list.find((t: any) => t.id === kot.id).status).toBe('PREPARING');
      await advance(kot.id, ['READY']);
      expect(
        (await kitchen.get(`/kds/tickets${q}`).expect(200)).body.find(
          (t: any) => t.id === kot.id,
        ).status,
      ).toBe('READY');
      await advance(kot.id, ['SERVED']);
      expect(
        (await kitchen.get(`/kds/tickets${q}`).expect(200)).body.some(
          (t: any) => t.id === kot.id,
        ),
      ).toBe(false);
    });

    it('a station-pinned screen still shows tickets with no station', async () => {
      const order = await newDineIn(tables.D);
      const [kot] = order.kots;
      const station = await prisma.kitchenStation.create({
        data: { branchId: BRANCH, name: `Grill-${tag}` },
      });
      const pinned = (
        await kitchen
          .get(`/kds/tickets${q}&stationId=${station.id}`)
          .expect(200)
      ).body;
      expect(kot.stationId).toBeNull();
      expect(pinned.some((t: any) => t.id === kot.id)).toBe(true);
    });
  });

  // ------------------------------------------------- rejection / cancelling
  describe('kitchen rejection and cancellation', () => {
    it('rejecting the only ticket withdraws the order, frees the table, keeps the record', async () => {
      const order = await newDineIn(tables.E);
      const [kot] = order.kots;
      expect(
        (await kitchen.post(`/kds/tickets/${kot.id}/reject${q}`, {})).status,
      ).toBe(400);
      expect(
        (
          await waiter.post(`/kds/tickets/${kot.id}/reject${q}`, {
            reason: 'x',
          })
        ).status,
      ).toBe(403);

      const m = mark();
      const res = await kitchen.post(`/kds/tickets/${kot.id}/reject${q}`, {
        reason: 'Out of paneer',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        rejectReason: 'Out of paneer',
      });
      expect(res.body.rejectedById).toBeTruthy();
      expect(res.body.rejectedAt).toBeTruthy();

      const d = await detail(order.id); // never deleted
      expect(d.status).toBe('CANCELLED');
      expect(d.cancelSource).toBe('KITCHEN_REJECTED');
      expect(d.cancelReason).toBe('Out of paneer');
      expect(await tableStatus(tables.E)).toBe('AVAILABLE');
      expect(
        (await kitchen.get(`/kds/tickets${q}`).expect(200)).body.some(
          (t: any) => t.id === kot.id,
        ),
      ).toBe(false);
      for (const ev of ['kot.updated', 'order.updated', 'table.updated'])
        expect(seen(ev, m).length).toBeGreaterThan(0);
      const audit = await prisma.auditLog.findFirst({
        where: { entity: 'Kot', entityId: kot.id, action: 'kot.rejected' },
      });
      expect(audit?.metadata).toMatchObject({
        reason: 'Out of paneer',
        wholeOrderCancelled: true,
      });

      // A rejected order is not payable.
      expect(
        (
          await cashier.post(`/orders/${order.id}/checkout${q}`, {
            payments: [{ method: 'CASH', amount: 236 }],
          })
        ).status,
      ).toBe(400);
    });

    it('rejecting one round keeps the order and takes only that round off the bill', async () => {
      const order = await newDineIn(tables.F); // 2 x 100
      await advance(order.kots[0].id, [
        'ACCEPTED',
        'PREPARING',
        'READY',
        'SERVED',
      ]);
      const more = await waiter
        .post(`/orders/${order.id}/items${q}`, {
          items: [{ menuItemId: item2Id, quantity: 2, modifierIds: [] }],
        })
        .expect(201);
      const round2 = more.body.kots.find((k: any) => k.id !== order.kots[0].id);
      expect(round2.status).toBe('NEW');
      expect(Number(more.body.totalAmount)).toBe(300);

      await kitchen
        .post(`/kds/tickets/${round2.id}/reject${q}`, {
          reason: 'No naan left',
        })
        .expect(201);
      const d = await detail(order.id);
      expect(d.status).toBe('OPEN');
      expect(Number(d.subtotal)).toBe(200);
      expect(Number(d.totalAmount)).toBe(200);
      expect(await tableStatus(tables.F)).toBe('OCCUPIED');
      const audit = await prisma.auditLog.findFirst({
        where: { entity: 'Kot', entityId: round2.id, action: 'kot.rejected' },
      });
      expect((audit?.metadata as any).lines[0]).toMatchObject({ quantity: 2 });
    });

    it('food already cooking needs a manager and an explicit confirmation', async () => {
      const order = await newDineIn(tables.G);
      const [kot] = order.kots;
      await advance(kot.id, ['ACCEPTED', 'PREPARING']);

      const byKitchen = await kitchen.post(
        `/kds/tickets/${kot.id}/reject${q}`,
        { reason: 'x' },
      );
      expect(byKitchen.status).toBe(403);
      const noConfirm = await manager.post(
        `/kds/tickets/${kot.id}/reject${q}`,
        { reason: 'Spoiled' },
      );
      expect(noConfirm.status).toBe(409);
      expect(noConfirm.body.code).toBe('KITCHEN_STARTED');
      expect((await detail(order.id)).status).toBe('OPEN');

      const ok = await manager.post(`/kds/tickets/${kot.id}/reject${q}`, {
        reason: 'Spoiled',
        confirmStarted: true,
      });
      expect(ok.status).toBe(201);
      const d = await detail(order.id);
      expect(d.status).toBe('CANCELLED');
      expect(d.cancelSource).toBe('KITCHEN_REJECTED');
      const audit = await prisma.auditLog.findFirst({
        where: { entity: 'Kot', entityId: kot.id, action: 'kot.rejected' },
      });
      expect(audit?.metadata).toMatchObject({ kitchenStarted: true });
    });

    it('staff and guest cancellations are recorded differently from kitchen rejection', async () => {
      const a = await newOnlineAccepted();
      const res = await manager.post(`/orders/${a.id}/cancel${q}`, {
        reason: 'Guest changed their mind',
        source: 'CUSTOMER',
      });
      expect(res.status).toBe(201);
      expect(res.body.cancelSource).toBe('CUSTOMER');

      const b = await newOnlineAccepted();
      await advance(b.kots[0].id, ['ACCEPTED']);
      // Once the kitchen has accepted, a reason is required.
      expect(
        (await manager.post(`/orders/${b.id}/cancel${q}`, {})).status,
      ).toBe(400);
      const staff = await manager.post(`/orders/${b.id}/cancel${q}`, {
        reason: 'Wrong order',
      });
      expect(staff.body.cancelSource).toBe('STAFF');
      expect(staff.body.status).toBe('CANCELLED');

      // Cancelling needs the permission; a cook cannot.
      const c = await newOnlineAccepted();
      expect(
        (await kitchen.post(`/orders/${c.id}/cancel${q}`, { reason: 'x' }))
          .status,
      ).toBe(403);
    });
  });

  async function newOnlineAccepted() {
    const o = await newOnline();
    await owner.post(`/orders/${o.id}/accept${q}`).expect(201);
    return detail(o.id);
  }

  // ----------------------------------------------------------- bill + pay
  describe('bill, discount and payment', () => {
    let order: any;
    const total = 200; // 2 x 100 incl. 18% tax
    const taxAfter10 = 27.46; // 200 - 200/1.18 = 30.51, scaled by 0.9

    beforeAll(async () => {
      order = await newDineIn(tables.H);
    });

    it('prices the bill on the server with the discount as both percent and amount', async () => {
      const res = await cashier
        .post(`/orders/${order.id}/bill-preview${q}`, { discountPercent: 10 })
        .expect(201);
      expect(res.body).toMatchObject({
        subtotal: total,
        discountAmount: 20,
        discountPercent: 10,
        discountType: 'PERCENT',
        discountValue: 10,
        totalDue: 180,
        amountPaid: 0,
        balanceDue: 180,
      });
      expect(res.body.taxAmount).toBeCloseTo(taxAfter10, 2);

      const flat = await cashier
        .post(`/orders/${order.id}/bill-preview${q}`, { discountFlat: 50 })
        .expect(201);
      expect(flat.body).toMatchObject({
        discountAmount: 50,
        discountPercent: 25,
        discountType: 'FIXED',
        totalDue: 150,
      });

      const tipped = await cashier
        .post(`/orders/${order.id}/bill-preview${q}`, {
          discountPercent: 10,
          tipAmount: 15,
        })
        .expect(201);
      expect(tipped.body.totalDue).toBe(195);

      // A waiter holds no discounts.apply, so cannot price one in.
      expect(
        (
          await waiter.post(`/orders/${order.id}/bill-preview${q}`, {
            discountPercent: 10,
          })
        ).status,
      ).toBe(403);
      // Kitchen has no billing access at all.
      expect(
        (await kitchen.post(`/orders/${order.id}/bill-preview${q}`, {})).status,
      ).toBe(403);
    });

    it('prints the bill before payment without charging or closing anything', async () => {
      const m = mark();
      for (let i = 0; i < 2; i++) {
        const html = await cashier
          .get(
            `/orders/${order.id}/receipt${q}&discountPercent=10&tipAmount=15`,
          )
          .expect(200);
        expect(html.text).toContain('TOTAL DUE');
        expect(html.text).toContain('Bill only');
        expect(html.text).toContain('Discount (10%)');
        expect(html.text).toContain('- ₹20.00');
        expect(html.text).toContain('₹195.00');
        expect(html.text).toContain('Balance due');
        expect(html.text).not.toContain('GRAND TOTAL');
      }
      const d = await detail(order.id);
      expect(d.status).toBe('OPEN');
      expect(d.payments).toHaveLength(0);
      expect(Number(d.discountAmount)).toBe(0); // nothing saved by printing
      expect(await tableStatus(tables.H)).toBe('OCCUPIED');
      expect(seen('order.updated', m)).toHaveLength(0);
      const prints = await prisma.auditLog.count({
        where: {
          entity: 'Order',
          entityId: order.id,
          action: 'order.bill_printed',
        },
      });
      expect(prints).toBe(2);
    });

    it('refuses a short or oversized payment unless it is allowed', async () => {
      const dto = { discountPercent: 10 };
      const short = await cashier.post(`/orders/${order.id}/checkout${q}`, {
        ...dto,
        payments: [{ method: 'CASH', amount: 100 }],
      });
      expect(short.status).toBe(400);
      expect(short.body.message).toMatch(/do not cover/i);
      const over = await cashier.post(`/orders/${order.id}/checkout${q}`, {
        ...dto,
        payments: [{ method: 'CARD', amount: 500 }],
      });
      expect(over.status).toBe(400);
      expect((await detail(order.id)).payments).toHaveLength(0);
    });

    it('records a part payment, locks the bill and leaves the table occupied', async () => {
      const requestId = randomUUID();
      const m = mark();
      const res = await cashier.post(`/orders/${order.id}/checkout${q}`, {
        discountPercent: 10,
        allowPartial: true,
        requestId,
        payments: [{ method: 'CASH', amount: 100 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('OPEN');
      expect(res.body.settlement).toEqual({
        amountDue: 180,
        amountPaid: 100,
        balanceDue: 80,
        changeDue: 0,
        fullyPaid: false,
      });
      expect(await tableStatus(tables.H)).toBe('OCCUPIED');
      const d = await detail(order.id);
      expect(Number(d.discountAmount)).toBe(20);
      expect(d.discountType).toBe('PERCENT');
      expect(Number(d.discountValue)).toBe(10);
      expect(Number(d.totalAmount)).toBe(180);
      expect(Number(d.taxAmount)).toBeCloseTo(taxAfter10, 2);
      expect(seen('order.updated', m)[0].payload).toMatchObject({
        balanceDue: 80,
      });

      // Double submission of the same attempt does not charge twice.
      const replay = await cashier.post(`/orders/${order.id}/checkout${q}`, {
        discountPercent: 10,
        allowPartial: true,
        requestId,
        payments: [{ method: 'CASH', amount: 100 }],
      });
      expect(replay.status).toBe(201);
      expect(replay.body.settlement.balanceDue).toBe(80);
      expect((await detail(order.id)).payments).toHaveLength(1);

      // Locked: no re-discounting, no new items, no merging under a part payment.
      const redo = await cashier.post(`/orders/${order.id}/checkout${q}`, {
        discountPercent: 50,
        payments: [{ method: 'CASH', amount: 80 }],
      });
      expect(redo.status).toBe(400);
      const add = await waiter.post(`/orders/${order.id}/items${q}`, {
        items: [{ menuItemId: item2Id, quantity: 1, modifierIds: [] }],
      });
      expect(add.status).toBe(409);

      // The bill now shows what is already paid.
      const html = await cashier
        .get(`/orders/${order.id}/receipt${q}`)
        .expect(200);
      expect(html.text).toContain('Discount (10%)');
      expect(html.text).toContain('₹100.00');
      expect(html.text).toContain('₹80.00');
    });

    it('settles the balance with change due, then closes the bill and frees the table', async () => {
      const m = mark();
      const res = await cashier.post(`/orders/${order.id}/checkout${q}`, {
        payments: [
          { method: 'UPI', amount: 30 },
          { method: 'CASH', amount: 50, tendered: 100 },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('PAID');
      expect(res.body.settlement).toEqual({
        amountDue: 180,
        amountPaid: 180,
        balanceDue: 0,
        changeDue: 50,
        fullyPaid: true,
      });
      const d = await detail(order.id);
      expect(d.payments).toHaveLength(3);
      expect(
        d.payments.reduce((s: number, p: any) => s + Number(p.amount), 0),
      ).toBe(180);
      const cash = d.payments.find((p: any) => Number(p.tendered) === 100);
      expect(Number(cash.changeGiven)).toBe(50);
      expect(await tableStatus(tables.H)).toBe('AVAILABLE');
      expect(seen('table.updated', m).length).toBeGreaterThan(0);
      expect(seen('order.updated', m)[0].payload.status).toBe('PAID');

      // Receipt: paid in full, with the cash received and the change.
      const html = await cashier
        .get(`/orders/${order.id}/receipt${q}`)
        .expect(200);
      expect(html.text).toContain('GRAND TOTAL');
      expect(html.text).toContain('Discount (10%)');
      expect(html.text).toContain('Change');
      expect(html.text).not.toContain('Bill only');

      // Already closed: another payment is refused, not duplicated.
      expect(
        (
          await cashier.post(`/orders/${order.id}/checkout${q}`, {
            payments: [{ method: 'CASH', amount: 10 }],
          })
        ).status,
      ).toBe(400);
    });

    it('treats an over-sized cash amount from an older client as change', async () => {
      const o = await newDineIn(tables.B, [
        { menuItemId: item2Id, quantity: 2, modifierIds: [] },
      ]);
      const res = await cashier.post(`/orders/${o.id}/checkout${q}`, {
        payments: [{ method: 'CASH', amount: 200 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.settlement).toMatchObject({
        amountPaid: 100,
        changeDue: 100,
      });
      const p = (await detail(o.id)).payments[0];
      expect(Number(p.amount)).toBe(100);
      expect(Number(p.tendered)).toBe(200);
    });

    it('two simultaneous final payments settle once', async () => {
      const o = await newDineIn(tables.C, [
        { menuItemId: item2Id, quantity: 2, modifierIds: [] },
      ]);
      const pay = () =>
        cashier.post(`/orders/${o.id}/checkout${q}`, {
          payments: [{ method: 'CASH', amount: 100 }],
        });
      const results = await Promise.all([pay(), pay()]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect((await detail(o.id)).payments).toHaveLength(1);
    });

    it('kitchen cannot take payment; waiter can settle a bill but not discount it', async () => {
      const o = await newDineIn(tables.D, [
        { menuItemId: item2Id, quantity: 2, modifierIds: [] },
      ]);
      expect(
        (
          await kitchen.post(`/orders/${o.id}/checkout${q}`, {
            payments: [{ method: 'CASH', amount: 100 }],
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await waiter.post(`/orders/${o.id}/checkout${q}`, {
            discountPercent: 100,
            payments: [],
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await waiter.post(`/orders/${o.id}/checkout${q}`, {
            payments: [{ method: 'CASH', amount: 100 }],
          })
        ).status,
      ).toBe(201);
    });
  });

  // ------------------------------------------------------------------ RBAC
  describe('who can see what', () => {
    it('kitchen sees the kitchen only; no sales, billing or settings', async () => {
      expect((await kitchen.get(`/kds/tickets${q}`)).status).toBe(200);
      expect((await kitchen.get(`/kds/stations${q}`)).status).toBe(200);
      for (const path of [
        `/dashboard/summary${q}`,
        `/settings${q}`,
        `/reports/sales-daily${q}&from=2026-01-01&to=2026-12-31`,
        `/tables/floors${q}`,
        `/menu/items${q}`,
      ]) {
        expect((await kitchen.get(path)).status).toBe(403);
      }
    });

    it('waiter has tables, menu and orders but no revenue, settings or kitchen controls', async () => {
      for (const path of [
        `/tables/floors${q}`,
        `/menu/items${q}`,
        `/orders${q}`,
        `/kds/progress${q}`,
      ]) {
        expect((await waiter.get(path)).status).toBe(200);
      }
      for (const path of [
        `/dashboard/summary${q}`,
        `/settings${q}`,
        `/kds/tickets${q}`,
        `/reports/sales-daily${q}&from=2026-01-01&to=2026-12-31`,
      ]) {
        expect((await waiter.get(path)).status).toBe(403);
      }
    });

    it('the roles carry the new permission as designed', async () => {
      const me = async (a: Agent) =>
        (await a.get('/api/v1/auth/me').expect(200)).body.user
          .permissions as string[];
      for (const role of [
        'OWNER',
        'WAITER',
        'CASHIER',
        'KITCHEN_STAFF',
        'RESTAURANT_MANAGER',
      ]) {
        expect(await me(agents[role])).toContain('orders.accept');
      }
      expect(await me(agents.ACCOUNTANT)).not.toContain('orders.accept');
      expect(await me(agents.KITCHEN_STAFF)).not.toContain('orders.cancel');
    });
  });
});
