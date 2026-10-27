/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- supertest bodies are untyped by design */
// Table switching, cancellation, bill edits and kitchen-ticket printing,
// end to end against a REAL, migrated + seeded Postgres. Opt-in:
//   LIFECYCLE_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json orders-lifecycle
// The "kitchen printer" is a local TCP server that records the raw ESC/POS
// bytes, so ticket contents and failure handling are verified for real.
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import * as net from 'net';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const run = process.env.LIFECYCLE_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const q = `?branchId=${BRANCH}`;
const tag = randomUUID().slice(0, 6);
const ROLES = ['WAITER', 'CASHIER', 'KITCHEN_STAFF', 'RESTAURANT_MANAGER'];

// Records every job sent to it; `up=false` refuses connections like a dead printer.
function fakePrinter() {
  const jobs: Buffer[] = [];
  let server: net.Server | null = null;
  const start = (port = 0) =>
    new Promise<number>((resolve) => {
      server = net.createServer((sock) => {
        const chunks: Buffer[] = [];
        sock.on('data', (c) => chunks.push(c));
        sock.on('end', () => {
          const job = Buffer.concat(chunks);
          if (job.length > 0) jobs.push(job);
        });
        sock.on('error', () => undefined);
      });
      server.listen(port, '127.0.0.1', () =>
        resolve((server!.address() as net.AddressInfo).port),
      );
    });
  const stop = () =>
    new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
  return { jobs, start, stop };
}
const text = (b: Buffer) => b.toString('latin1');

run('Orders: tables, cancel, bill edits, KOT printing (e2e)', () => {
  let app: INestApplication<App>;
  let owner: ReturnType<typeof request.agent>;
  const agents: Record<string, ReturnType<typeof request.agent>> = {};
  let floorId: string;
  let menuItemId: string;
  let menuItem2Id: string;
  const tables: Record<string, string> = {};
  const printer = fakePrinter();

  const api = (a: ReturnType<typeof request.agent>) => ({
    get: (p: string) => a.get(`/api/v1${p}`),
    post: (p: string, b?: object) => a.post(`/api/v1${p}`).send(b),
    patch: (p: string, b?: object) => a.patch(`/api/v1${p}`).send(b),
  });
  const o = () => api(owner);

  const newOrder = async (
    tableId: string | undefined,
    items: object[] = [{ menuItemId, quantity: 2, modifierIds: [] }],
  ) => {
    const res = await o().post(`/orders${q}`, {
      type: tableId ? 'DINE_IN' : 'TAKEAWAY',
      tableId,
      items,
    });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body;
  };
  const tableStatus = async (id: string) => {
    const floors = (await o().get(`/tables/floors${q}`).expect(200)).body;
    for (const f of floors)
      for (const t of f.tables) if (t.id === id) return t.status as string;
    throw new Error('table missing');
  };
  const openAt = async (tableId: string) =>
    (await o().get(`/orders${q}&tableId=${tableId}`).expect(200)).body as {
      id: string;
      orderNumber: string;
    }[];
  const kotsOf = async (orderId: string) =>
    (await o().get(`/orders/${orderId}${q}`).expect(200)).body.kots as {
      id: string;
      status: string;
    }[];

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

    owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);
    const roles = (await o().get('/users/roles').expect(200)).body as {
      id: string;
      name: string;
    }[];
    for (const name of ROLES) {
      const email = `${name.toLowerCase()}-lc-${tag}@demo.local`;
      await o()
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

    const floors = (await o().get(`/tables/floors${q}`).expect(200)).body;
    floorId = floors[0].id;
    for (const n of ['A', 'B', 'C', 'D']) {
      const t = await o()
        .post(`/tables${q}`, { floorId, number: `${n}-${tag}`, capacity: 4 })
        .expect(201);
      tables[n] = t.body.id;
    }
    const cats = (await o().get(`/menu/categories${q}`).expect(200)).body;
    const mk = async (name: string) =>
      (
        await o()
          .post(`/menu/items${q}`, {
            categoryId: cats[0].id,
            name: `${name}-${tag}`,
            price: 100,
            taxRatePercent: 0,
          })
          .expect(201)
      ).body.id as string;
    menuItemId = await mk('Paneer');
    menuItem2Id = await mk('Naan');
  });

  afterAll(async () => {
    await printer.stop();
    await app.close();
  });

  // ---------------------------------------------------------------- tables
  describe('table switching', () => {
    it('each table keeps its own order and status', async () => {
      const a = await newOrder(tables.A);
      const b = await newOrder(tables.B);
      expect((await openAt(tables.A)).map((x) => x.id)).toEqual([a.id]);
      expect((await openAt(tables.B)).map((x) => x.id)).toEqual([b.id]);
      expect(await tableStatus(tables.A)).toBe('OCCUPIED');
      expect(await tableStatus(tables.B)).toBe('OCCUPIED');
    });

    it('refuses to mark a table with an unpaid bill as free', async () => {
      for (const status of ['AVAILABLE', 'CLEANING', 'RESERVED']) {
        const res = await o().patch(`/tables/${tables.A}/status${q}`, {
          status,
        });
        expect(res.status).toBe(409);
      }
      expect(await tableStatus(tables.A)).toBe('OCCUPIED');
    });

    it('paying one of two bills on a table keeps the table occupied', async () => {
      const first = (await openAt(tables.A))[0];
      const second = await newOrder(tables.A);
      expect((await openAt(tables.A)).length).toBe(2);
      const paid = await o().post(`/orders/${first.id}/checkout${q}`, {
        payments: [{ method: 'CASH', amount: 200 }],
      });
      expect(paid.status).toBe(201);
      expect(await tableStatus(tables.A)).toBe('OCCUPIED');
      expect((await openAt(tables.A)).map((x) => x.id)).toEqual([second.id]);
      // and the other table is untouched
      expect((await openAt(tables.B)).length).toBe(1);
    });

    it('moves a bill to a free table without losing items or tickets', async () => {
      const [order] = await openAt(tables.B);
      const before = (await o().get(`/orders/${order.id}${q}`).expect(200))
        .body;
      const moved = await o().patch(`/orders/${order.id}${q}`, {
        tableId: tables.C,
      });
      expect(moved.status).toBe(200);
      expect(moved.body.tableId).toBe(tables.C);
      expect(moved.body.items.length).toBe(before.items.length);
      expect(moved.body.kots.length).toBe(before.kots.length);
      expect(await tableStatus(tables.B)).toBe('AVAILABLE');
      expect(await tableStatus(tables.C)).toBe('OCCUPIED');
      expect((await openAt(tables.B)).length).toBe(0);
      expect((await openAt(tables.C)).map((x) => x.id)).toEqual([order.id]);
    });

    it('will not move a bill onto a table that has its own open bill', async () => {
      const [order] = await openAt(tables.C);
      const res = await o().patch(`/orders/${order.id}${q}`, {
        tableId: tables.A,
      });
      expect(res.status).toBe(409);
      expect((await openAt(tables.C)).map((x) => x.id)).toEqual([order.id]);
      expect((await openAt(tables.A)).length).toBe(1);
    });
  });

  // ---------------------------------------------------------------- cancel
  describe('cancellation', () => {
    it('cancels an unpaid order: status, table, tickets, audit reason', async () => {
      const order = await newOrder(tables.D);
      expect(await tableStatus(tables.D)).toBe('OCCUPIED');
      const res = await o().post(`/orders/${order.id}/cancel${q}`, {
        reason: 'Guest left',
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.cancelReason).toBe('Guest left');
      expect(res.body.cancelledAt).toBeTruthy();
      expect(await tableStatus(tables.D)).toBe('AVAILABLE');
      const kots = await kotsOf(order.id);
      expect(kots.length).toBeGreaterThan(0);
      expect(kots.every((k) => k.status === 'CANCELLED')).toBe(true);
      expect((await openAt(tables.D)).length).toBe(0);
      // not on the live KDS any more
      const live = (await o().get(`/kds/tickets${q}`).expect(200)).body as {
        orderId: string;
      }[];
      expect(live.some((k) => k.orderId === order.id)).toBe(false);
      // history is kept and the cancellation is in the audit trail
      const audit = (await o().get(`/audit-logs${q}&limit=50`)).body;
      if (Array.isArray(audit?.items ?? audit)) {
        expect(JSON.stringify(audit)).toContain(order.id);
      }
    });

    it('cancelling twice is rejected, not silently repeated', async () => {
      const order = await newOrder(tables.D);
      await o().post(`/orders/${order.id}/cancel${q}`, {}).expect(201);
      const again = await o().post(`/orders/${order.id}/cancel${q}`, {});
      expect(again.status).toBe(400);
    });

    it('keeps the table occupied when another bill is still open on it', async () => {
      const first = await newOrder(tables.D);
      const second = await newOrder(tables.D);
      await o().post(`/orders/${first.id}/cancel${q}`, {}).expect(201);
      expect(await tableStatus(tables.D)).toBe('OCCUPIED');
      await o().post(`/orders/${second.id}/cancel${q}`, {}).expect(201);
      expect(await tableStatus(tables.D)).toBe('AVAILABLE');
    });

    it('needs an explicit confirmation once the kitchen is cooking, and the order stays intact', async () => {
      const order = await newOrder(tables.D);
      const [kot] = await kotsOf(order.id);
      for (const status of ['ACCEPTED', 'PREPARING'])
        await o()
          .patch(`/kds/tickets/${kot.id}/status${q}`, { status })
          .expect(200);
      const res = await o().post(`/orders/${order.id}/cancel${q}`, {
        reason: 'Guest left',
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('KITCHEN_STARTED');
      expect(res.body.message).toMatch(/kitchen has already started/i);
      expect(
        (await o().get(`/orders/${order.id}${q}`).expect(200)).body.status,
      ).toBe('OPEN');
      expect(await tableStatus(tables.D)).toBe('OCCUPIED');
    });

    it('a paid bill cannot be cancelled (refund is the path)', async () => {
      const order = await newOrder(undefined);
      await o()
        .post(`/orders/${order.id}/checkout${q}`, {
          payments: [{ method: 'CASH', amount: 200 }],
        })
        .expect(201);
      const res = await o().post(`/orders/${order.id}/cancel${q}`, {});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/refund/i);
    });

    it('only roles with orders.cancel may cancel', async () => {
      const order = await newOrder(undefined);
      for (const role of ['WAITER', 'CASHIER', 'KITCHEN_STAFF']) {
        const res = await api(agents[role]).post(
          `/orders/${order.id}/cancel${q}`,
          {},
        );
        expect(res.status).toBe(403);
      }
      expect(
        (await o().get(`/orders/${order.id}${q}`).expect(200)).body.status,
      ).toBe('OPEN');
      await api(agents.RESTAURANT_MANAGER)
        .post(`/orders/${order.id}/cancel${q}`, { reason: 'test' })
        .expect(201);
    });
  });

  // ------------------------------------------------------------- bill edits
  describe('bill edits', () => {
    it('lowers a quantity and removes a line; totals follow', async () => {
      const order = await newOrder(undefined, [
        { menuItemId, quantity: 3, modifierIds: [] },
        { menuItemId: menuItem2Id, quantity: 1, modifierIds: [] },
      ]);
      expect(Number(order.totalAmount)).toBe(400);
      const line = order.items.find((i: any) => i.menuItemId === menuItemId);
      const lowered = await o().patch(
        `/orders/${order.id}/items/${line.id}${q}`,
        {
          quantity: 1,
          reason: 'guest changed mind',
        },
      );
      expect(lowered.status).toBe(200);
      expect(Number(lowered.body.totalAmount)).toBe(200);
      const naan = order.items.find((i: any) => i.menuItemId === menuItem2Id);
      const removed = await o().post(
        `/orders/${order.id}/items/${naan.id}/remove${q}`,
        { reason: 'wrong item' },
      );
      expect(removed.status).toBe(201);
      expect(removed.body.items.length).toBe(1);
      expect(Number(removed.body.totalAmount)).toBe(100);
      expect(Number(removed.body.subtotal)).toBe(100);
    });

    it('rejects raising a quantity, a removal with no reason, and removing the last line', async () => {
      const order = await newOrder(undefined, [
        { menuItemId, quantity: 1, modifierIds: [] },
        { menuItemId: menuItem2Id, quantity: 1, modifierIds: [] },
      ]);
      const [a, b] = order.items;
      expect(
        (
          await o().patch(`/orders/${order.id}/items/${a.id}${q}`, {
            quantity: 5,
          })
        ).status,
      ).toBe(400);
      expect(
        (await o().post(`/orders/${order.id}/items/${a.id}/remove${q}`, {}))
          .status,
      ).toBe(400);
      await o()
        .post(`/orders/${order.id}/items/${a.id}/remove${q}`, { reason: 'x' })
        .expect(201);
      const last = await o().post(
        `/orders/${order.id}/items/${b.id}/remove${q}`,
        { reason: 'x' },
      );
      expect(last.status).toBe(400);
      expect(last.body.message).toMatch(/cancel the order/i);
    });

    it('cannot change a line the kitchen is already cooking', async () => {
      const order = await newOrder(undefined, [
        { menuItemId, quantity: 2, modifierIds: [] },
        { menuItemId: menuItem2Id, quantity: 1, modifierIds: [] },
      ]);
      const kots = await kotsOf(order.id);
      for (const status of ['ACCEPTED', 'PREPARING'])
        await o()
          .patch(`/kds/tickets/${kots[0].id}/status${q}`, { status })
          .expect(200);
      // Every line on the cooking ticket is locked; lines on other tickets are not.
      const detail = (await o().get(`/orders/${order.id}${q}`).expect(200))
        .body;
      const cooking = detail.kots.find((k: any) => k.id === kots[0].id);
      const lockedIds = cooking.items.map((ki: any) => ki.orderItemId);
      expect(lockedIds.length).toBeGreaterThan(0);
      const locked = order.items.find((i: any) => lockedIds.includes(i.id));
      const res = await o().patch(
        `/orders/${order.id}/items/${locked.id}${q}`,
        {
          quantity: 1,
        },
      );
      expect(res.status === 409 || locked.quantity === 1).toBe(true);
      const rm = await o().post(
        `/orders/${order.id}/items/${locked.id}/remove${q}`,
        { reason: 'x' },
      );
      expect(rm.status).toBe(409);
      const after = (await o().get(`/orders/${order.id}${q}`).expect(200)).body;
      expect(after.items.length).toBe(2);
      expect(Number(after.totalAmount)).toBe(300);
    });

    it('edits header details; a paid bill is immutable', async () => {
      const order = await newOrder(undefined);
      const edited = await o().patch(`/orders/${order.id}${q}`, {
        guestName: 'Asha',
        notes: 'less salt',
      });
      expect(edited.status).toBe(200);
      expect(edited.body.guestName).toBe('Asha');
      await o()
        .post(`/orders/${order.id}/checkout${q}`, {
          payments: [{ method: 'CASH', amount: 200 }],
        })
        .expect(201);
      const line = order.items[0];
      for (const res of [
        await o().patch(`/orders/${order.id}${q}`, { notes: 'late edit' }),
        await o().patch(`/orders/${order.id}/items/${line.id}${q}`, {
          quantity: 1,
        }),
        await o().post(`/orders/${order.id}/items/${line.id}/remove${q}`, {
          reason: 'x',
        }),
      ]) {
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/paid|open/i);
      }
    });

    it('waiter/cashier/manager may edit; kitchen staff may not', async () => {
      const order = await newOrder(undefined);
      for (const role of ['WAITER', 'CASHIER', 'RESTAURANT_MANAGER']) {
        const res = await api(agents[role]).patch(`/orders/${order.id}${q}`, {
          notes: `by ${role}`,
        });
        expect(res.status).toBe(200);
      }
      const denied = await api(agents.KITCHEN_STAFF).patch(
        `/orders/${order.id}${q}`,
        { notes: 'nope' },
      );
      expect(denied.status).toBe(403);
    });
  });

  // ------------------------------------------------------------------ KOT
  describe('kitchen ticket printing (network printer)', () => {
    let port: number;
    beforeAll(async () => {
      port = await printer.start();
      await o()
        .patch(`/settings/branch${q}`, {
          printerConnection: 'NETWORK',
          printerHost: '127.0.0.1',
          printerPort: port,
          printerPaperWidthMm: 80,
        })
        .expect(200);
    });
    afterAll(async () => {
      await o()
        .patch(`/settings/branch${q}`, { printerConnection: 'USB' })
        .expect(200);
    });

    it('network mode needs an address', async () => {
      await o()
        .patch(`/settings/branch${q}`, {
          printerConnection: 'NETWORK',
          printerHost: null,
        })
        .expect(400);
      await o()
        .patch(`/settings/branch${q}`, {
          printerHost: '127.0.0.1',
          printerPort: port,
        })
        .expect(200);
    });

    it('diagnostics report the network printer as reachable', async () => {
      const res = await o().get(`/orders/print/diagnostics${q}`).expect(200);
      expect(res.body.connection).toBe('NETWORK');
      expect(res.body.network.reachable).toBe(true);
      expect(res.body.canPrint).toBe(true);
    });

    it('test print and KOT test print reach the printer', async () => {
      printer.jobs.length = 0;
      await o().post(`/orders/print/test${q}`).expect(201);
      await o().post(`/orders/print/test${q}&kind=kot`).expect(201);
      await new Promise((r) => setTimeout(r, 100));
      expect(printer.jobs.length).toBe(2);
      expect(text(printer.jobs[0])).toContain('Printer test OK');
      expect(text(printer.jobs[1])).toContain('KITCHEN ORDER');
      expect(text(printer.jobs[1])).toContain('Sample dish');
    });

    it('prints order/table, items, quantities and notes - and only once', async () => {
      printer.jobs.length = 0;
      const order = await newOrder(tables.A, [
        {
          menuItemId,
          quantity: 2,
          modifierIds: [],
          kitchenNote: 'extra spicy',
        },
      ]);
      const first = await o().post(`/orders/${order.id}/print/kot${q}`);
      expect(first.status).toBe(201);
      expect(first.body.printed.length).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 100));
      const paper = text(Buffer.concat(printer.jobs));
      expect(paper).toContain(`#${order.orderNumber}`);
      expect(paper).toContain('Table');
      expect(paper).toContain('2 x Paneer');
      expect(paper).toContain('NOTE: extra spicy');
      expect(paper).not.toContain('REPRINT');

      // A retry (double tap / flaky client) must not print a second ticket.
      const jobsAfterFirst = printer.jobs.length;
      const retry = await o().post(`/orders/${order.id}/print/kot${q}`);
      expect(retry.status).toBe(409);
      expect(retry.body.code ?? retry.body.message?.code).toBe(
        'ALREADY_PRINTED',
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(printer.jobs.length).toBe(jobsAfterFirst);

      // Parallel taps: exactly one wins.
      const order2 = await newOrder(undefined);
      const before = printer.jobs.length;
      const results = await Promise.all([
        o().post(`/orders/${order2.id}/print/kot${q}`),
        o().post(`/orders/${order2.id}/print/kot${q}`),
        o().post(`/orders/${order2.id}/print/kot${q}`),
      ]);
      await new Promise((r) => setTimeout(r, 150));
      const ok = results.filter((r) => r.status === 201).length;
      expect(ok).toBe(1);
      expect(printer.jobs.length - before).toBe(1);
    });

    it('an intentional reprint is allowed and stamped REPRINT', async () => {
      const order = await newOrder(undefined);
      await o().post(`/orders/${order.id}/print/kot${q}`).expect(201);
      printer.jobs.length = 0;
      const re = await o().post(
        `/orders/${order.id}/print/kot${q}&reprint=true`,
      );
      expect(re.status).toBe(201);
      await new Promise((r) => setTimeout(r, 100));
      expect(text(Buffer.concat(printer.jobs))).toContain('REPRINT #1');
      // and the KDS reprint button does the same for a single ticket
      const [kot] = await kotsOf(order.id);
      printer.jobs.length = 0;
      await o().post(`/kds/tickets/${kot.id}/reprint${q}`).expect(201);
      await new Promise((r) => setTimeout(r, 100));
      expect(text(Buffer.concat(printer.jobs))).toContain('REPRINT #2');
    });

    it('a new round prints only the new ticket', async () => {
      const order = await newOrder(undefined);
      await o().post(`/orders/${order.id}/print/kot${q}`).expect(201);
      await o()
        .post(`/orders/${order.id}/items${q}`, {
          items: [{ menuItemId: menuItem2Id, quantity: 1, modifierIds: [] }],
        })
        .expect(201);
      printer.jobs.length = 0;
      await o().post(`/orders/${order.id}/print/kot${q}`).expect(201);
      await new Promise((r) => setTimeout(r, 100));
      const paper = text(Buffer.concat(printer.jobs));
      expect(paper).toContain('1 x Naan');
      expect(paper).not.toContain('Paneer');
    });

    it('a dead printer gives a clear error and the retry still prints once', async () => {
      const order = await newOrder(undefined);
      await printer.stop();
      const fail = await o().post(`/orders/${order.id}/print/kot${q}`);
      expect(fail.status).toBe(503);
      expect(fail.body.message).toMatch(/printer/i);
      const diag = await o().get(`/orders/print/diagnostics${q}`).expect(200);
      expect(diag.body.canPrint).toBe(false);
      expect(diag.body.network.reachable).toBe(false);

      await printer.start(port);
      printer.jobs.length = 0;
      const retry = await o().post(`/orders/${order.id}/print/kot${q}`);
      expect(retry.status).toBe(201);
      await new Promise((r) => setTimeout(r, 100));
      expect(printer.jobs.length).toBe(1);
      expect((await o().post(`/orders/${order.id}/print/kot${q}`)).status).toBe(
        409,
      );
    });

    it('a cancelled ticket is not printed', async () => {
      const order = await newOrder(undefined);
      await o().post(`/orders/${order.id}/cancel${q}`, {}).expect(201);
      const res = await o().post(`/orders/${order.id}/print/kot${q}`);
      expect(res.status).toBe(409);
    });
  });
});
