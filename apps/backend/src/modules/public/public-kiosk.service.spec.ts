/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- supertest bodies and jest mock calls are untyped by design */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PublicKioskService } from './public-kiosk.service';

const TOKEN = 'a'.repeat(32);
const REQUEST_ID = '2f1a9a52-6c1c-4a39-9b0e-3f9e0f4c6d11';

const branch = {
  id: 'b1',
  isActive: true,
  kioskDineInEnabled: true,
  kioskTakeawayEnabled: true,
  restaurant: { currency: 'EUR' },
};

const dec = (v: string) => new Prisma.Decimal(v);
const storedOrder = {
  orderNumber: '20261017-0001',
  createdAt: new Date('2026-10-17T10:00:00Z'),
  notes: 'Kiosk · Takeaway',
  subtotal: dec('11'),
  taxAmount: dec('1'),
  totalAmount: dec('11'),
  items: [{ nameSnapshot: 'Café', quantity: 2, lineTotal: dec('11') }],
  // Fields that must never reach the public response:
  id: 'internal-id',
  createdById: 'staff-1',
};

function build() {
  const prisma = {
    branch: { findUnique: jest.fn().mockResolvedValue(branch) },
    order: { findFirst: jest.fn().mockResolvedValue(null) },
    menuItem: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'i1', isActive: true, category: { isActive: true } },
        ]),
    },
    userBranch: {
      findFirst: jest.fn().mockResolvedValue({ userId: 'staff-1' }),
    },
  };
  const ordersService = {
    beginRequest: jest.fn().mockResolvedValue(null),
    createOrder: jest.fn().mockResolvedValue(storedOrder),
  };
  const publicMenu = {
    menuCategoriesForBranch: jest.fn().mockResolvedValue([]),
    guestCategories: jest.fn().mockResolvedValue([]),
  };
  const messaging = { dispatch: jest.fn().mockResolvedValue({ status: 'SENT', error: null }) };
  const service = new PublicKioskService(
    prisma as never,
    ordersService as never,
    publicMenu as never,
    messaging as never,
  );
  return { service, prisma, ordersService, publicMenu, messaging };
}

const dto = (over: Record<string, unknown> = {}) => ({
  requestId: REQUEST_ID,
  serviceType: 'TAKEAWAY' as const,
  items: [{ menuItemId: 'i1', quantity: 2, modifierIds: [] }],
  ...over,
});

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('PublicKioskService', () => {
  describe('token handling', () => {
    it('rejects a malformed token without querying the database', async () => {
      const { service, prisma } = build();
      await expect(service.getMenu('short')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.branch.findUnique).not.toHaveBeenCalled();
    });

    it('rejects an unknown or inactive branch', async () => {
      const { service, prisma } = build();
      prisma.branch.findUnique.mockResolvedValueOnce(null);
      await expect(service.getMenu(TOKEN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      prisma.branch.findUnique.mockResolvedValueOnce({
        ...branch,
        isActive: false,
      });
      await expect(service.getMenu(TOKEN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('createOrder', () => {
    it('creates a KIOSK order via the shared order rules, keyed by requestId', async () => {
      const { service, ordersService } = build();
      await service.createOrder(TOKEN, dto());
      expect(ordersService.createOrder).toHaveBeenCalledTimes(1);
      const [branchId, actor, order, options] =
        ordersService.createOrder.mock.calls[0];
      expect(branchId).toBe('b1');
      expect(actor).toBe('staff-1');
      expect(order).toMatchObject({ type: 'KIOSK', notes: 'Kiosk · Takeaway' });
      // goes straight to the kitchen: no acceptance gate requested
      expect(options).toEqual({
        channel: 'ONLINE',
        clientRequestId: REQUEST_ID,
      });
    });

    it('returns only public fields (no internal ids, staff or payment data)', async () => {
      const { service } = build();
      const res = await service.createOrder(TOKEN, dto());
      expect(res).toEqual({
        orderNumber: '20261017-0001',
        createdAt: storedOrder.createdAt,
        currency: 'EUR',
        items: [{ name: 'Café', quantity: 2, lineTotal: '11' }],
        subtotal: '11',
        taxAmount: '1',
        totalAmount: '11',
        paid: false,
      });
    });

    it('a retry with the same requestId returns the original and creates nothing', async () => {
      const { service, prisma, ordersService } = build();
      ordersService.beginRequest.mockResolvedValueOnce('existing');
      prisma.order.findFirst.mockResolvedValueOnce(storedOrder);
      const res = await service.createOrder(TOKEN, dto());
      expect(res.orderNumber).toBe('20261017-0001');
      expect(ordersService.createOrder).not.toHaveBeenCalled();
    });

    it('a concurrent duplicate (unique violation) resolves to the existing order', async () => {
      const { service, prisma, ordersService } = build();
      ordersService.createOrder.mockRejectedValueOnce(p2002());
      prisma.order.findFirst.mockResolvedValueOnce(storedOrder);
      const res = await service.createOrder(TOKEN, dto());
      expect(res.orderNumber).toBe('20261017-0001');
      expect(ordersService.createOrder).toHaveBeenCalledTimes(1);
    });

    it('retries when two orders race for the same order number', async () => {
      const { service, ordersService } = build();
      ordersService.createOrder
        .mockRejectedValueOnce(p2002())
        .mockResolvedValueOnce(storedOrder);
      const res = await service.createOrder(TOKEN, dto());
      expect(res.orderNumber).toBe('20261017-0001');
      expect(ordersService.createOrder).toHaveBeenCalledTimes(2);
    });

    it('gives up after bounded retries instead of looping forever', async () => {
      const { service, ordersService } = build();
      ordersService.createOrder.mockRejectedValue(p2002());
      await expect(service.createOrder(TOKEN, dto())).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
      expect(ordersService.createOrder).toHaveBeenCalledTimes(3);
    });

    it('reports unavailable products with a machine-readable code', async () => {
      const { service, prisma, ordersService } = build();
      prisma.menuItem.findMany.mockResolvedValueOnce([
        { id: 'i1', isActive: false, category: { isActive: true } },
      ]);
      const err = await service.createOrder(TOKEN, dto()).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: 'ITEM_UNAVAILABLE',
        unavailableItemIds: ['i1'],
      });
      expect(ordersService.createOrder).not.toHaveBeenCalled();
    });

    it('treats an item in a switched-off category or an unknown id as unavailable', async () => {
      const { service, prisma } = build();
      prisma.menuItem.findMany.mockResolvedValueOnce([
        { id: 'i1', isActive: true, category: { isActive: false } },
      ]);
      await expect(service.createOrder(TOKEN, dto())).rejects.toBeInstanceOf(
        ConflictException,
      );
      prisma.menuItem.findMany.mockResolvedValueOnce([]);
      await expect(service.createOrder(TOKEN, dto())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('refuses a service type the branch has switched off', async () => {
      const { service, prisma, ordersService } = build();
      prisma.branch.findUnique.mockResolvedValue({
        ...branch,
        kioskDineInEnabled: false,
      });
      await expect(
        service.createOrder(TOKEN, dto({ serviceType: 'DINE_IN' })),
      ).rejects.toThrow('not available');
      expect(ordersService.createOrder).not.toHaveBeenCalled();
    });
  });

  describe('getMenu', () => {
    it('exposes tax/currency config and hides empty categories', async () => {
      const { service, publicMenu } = build();
      publicMenu.guestCategories.mockResolvedValueOnce([
        { id: 'c1', name: 'Empty', items: [] },
        { id: 'c2', name: 'Food', items: [{ id: 'i1' }] },
      ]);
      prismaBranch(service, {
        ...branch,
        name: 'Centro',
        country: 'ES',
        taxMode: 'INCLUSIVE',
        taxRegime: 'ES_IVA',
        taxLabel: null,
        restaurant: { name: 'Bar', logoUrl: null, currency: 'EUR' },
      });
      const menu = await service.getMenu(TOKEN);
      expect(menu).toMatchObject({
        currency: 'EUR',
        country: 'ES',
        taxMode: 'INCLUSIVE',
        taxLabel: 'IVA',
        services: { dineIn: true, takeaway: true },
      });
      expect(menu.categories.map((c: { id: string }) => c.id)).toEqual(['c2']);
    });
  });

  describe('sendWhatsAppReceipt', () => {
    it('sends a not-paid receipt to the guest number', async () => {
      const { service, prisma, messaging } = build();
      prisma.branch.findUnique.mockResolvedValue({
        ...branch,
        restaurantId: 'r1',
        country: 'IN',
        restaurant: {
          id: 'r1',
          name: 'ABA',
          currency: 'INR',
          smsCountryPrefix: '91',
        },
      });
      prisma.order.findFirst.mockResolvedValue({
        ...storedOrder,
        status: 'OPEN',
        clientRequestId: REQUEST_ID,
      });
      const result = await service.sendWhatsAppReceipt(TOKEN, {
        requestId: REQUEST_ID,
        phone: '9618613439',
      });
      expect(result.status).toBe('SENT');
      expect(messaging.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'WHATSAPP',
          purpose: 'RECEIPT',
          to: '919618613439',
        }),
      );
      const body = String(messaging.dispatch.mock.calls[0][0].body);
      expect(body.split('\n')).toContain('NOT PAID RECEIPT');
    });

    it('rejects a number that is too short', async () => {
      const { service } = build();
      await expect(
        service.sendWhatsAppReceipt(TOKEN, { requestId: REQUEST_ID, phone: '123' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

function prismaBranch(service: PublicKioskService, value: unknown) {
  (
    service as unknown as {
      prisma: { branch: { findUnique: jest.Mock } };
    }
  ).prisma.branch.findUnique.mockResolvedValue(value);
}
