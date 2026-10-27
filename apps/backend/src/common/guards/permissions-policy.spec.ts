import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  DEFAULT_ROLE_PERMISSIONS,
  STAFF_ROLES,
  type StaffRole,
} from '@nodedr-restaurant/types';
import { DashboardController } from '../../modules/dashboard/dashboard.controller';
import { MenuController } from '../../modules/menu/menu.controller';
import { TablesController } from '../../modules/tables/tables.controller';
import { PermissionsGuard } from './permissions.guard';
import {
  assertCanViewReport,
  canViewReport,
  REPORT_CATALOG,
  SALES_REPORT_KEYS,
} from '../../modules/reports/reports.service';

// Runs the real PermissionsGuard against the real @Auth() metadata on the
// controllers, using the default permission bundle of every system role.
const guard = new PermissionsGuard(new Reflector());

function allowed(
  role: string | string[],
  controller: new (...a: never[]) => unknown,
  method: string,
): boolean {
  const permissions =
    typeof role === 'string'
      ? DEFAULT_ROLE_PERMISSIONS[role as StaffRole]
      : role;
  const handler = (controller.prototype as Record<string, () => unknown>)[
    method
  ];
  if (typeof handler !== 'function') {
    throw new Error(`${controller.name}.${method} does not exist`);
  }
  const ctx = {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { permissions } }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(ctx);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

describe('dashboard sales policy', () => {
  const sales = ['ACCOUNTANT', 'ADMINISTRATOR', 'CASHIER', 'OWNER'];

  it.each(['getSummary', 'getTrends'])(
    '%s is open only to owner/admin/accountant/cashier by default',
    (method) => {
      const ok = STAFF_ROLES.filter((r) =>
        allowed(r, DashboardController, method),
      );
      expect([...ok].sort()).toEqual(sales);
    },
  );

  it.each([
    'WAITER',
    'KITCHEN_STAFF',
    'CHEF',
    'BARTENDER',
    'DELIVERY_STAFF',
    'INVENTORY_MANAGER',
    'RESTAURANT_MANAGER',
  ])('%s cannot read revenue or trends', (role) => {
    expect(allowed(role, DashboardController, 'getSummary')).toBe(false);
    expect(allowed(role, DashboardController, 'getTrends')).toBe(false);
  });

  it('sales.view alone does not unlock the dashboard', () => {
    expect(allowed(['sales.view'], DashboardController, 'getSummary')).toBe(
      false,
    );
    expect(
      allowed(['dashboard.sales.view'], DashboardController, 'getSummary'),
    ).toBe(true);
  });
});

describe('waiter menu and tables access', () => {
  it('can read categories, items, floors and table requests', () => {
    expect(allowed('WAITER', MenuController, 'listCategories')).toBe(true);
    expect(allowed('WAITER', MenuController, 'listItems')).toBe(true);
    expect(allowed('WAITER', TablesController, 'listFloors')).toBe(true);
    expect(allowed('WAITER', TablesController, 'listRequests')).toBe(true);
  });

  it('can update table status and resolve requests (operational)', () => {
    expect(allowed('WAITER', TablesController, 'updateStatus')).toBe(true);
    expect(allowed('WAITER', TablesController, 'resolveRequest')).toBe(true);
  });

  it('cannot edit the menu or the floor plan', () => {
    for (const m of [
      'createCategory',
      'updateCategory',
      'deleteCategory',
      'createItem',
      'updateItem',
      'deleteItem',
    ]) {
      expect(allowed('WAITER', MenuController, m)).toBe(false);
    }
    for (const m of [
      'createFloor',
      'updateFloor',
      'createTable',
      'createTables',
      'rotateQrToken',
      'updateTable',
      'updateLayout',
      'deleteTable',
    ]) {
      expect(allowed('WAITER', TablesController, m)).toBe(false);
    }
  });

  it('kitchen staff cannot read floors; managers keep full access', () => {
    expect(allowed('KITCHEN_STAFF', TablesController, 'listFloors')).toBe(
      false,
    );
    expect(allowed('RESTAURANT_MANAGER', MenuController, 'createItem')).toBe(
      true,
    );
    expect(allowed('RESTAURANT_MANAGER', TablesController, 'updateTable')).toBe(
      true,
    );
  });

  it('legacy roles holding only *.manage still pass the read routes', () => {
    expect(allowed(['menu.manage'], MenuController, 'listItems')).toBe(true);
    expect(allowed(['tables.manage'], TablesController, 'listFloors')).toBe(
      true,
    );
  });
});

describe('sales reports', () => {
  it('hide revenue reports without dashboard.sales.view', () => {
    const inv = DEFAULT_ROLE_PERMISSIONS.INVENTORY_MANAGER;
    expect(canViewReport(inv, 'sales-daily')).toBe(false);
    expect(canViewReport(inv, 'tax')).toBe(false);
    expect(canViewReport(inv, 'waste')).toBe(true);
    expect(() => assertCanViewReport(inv, 'staff-sales')).toThrow(
      ForbiddenException,
    );
  });

  it('are available to accountants and cashiers', () => {
    for (const key of SALES_REPORT_KEYS) {
      expect(canViewReport(DEFAULT_ROLE_PERMISSIONS.ACCOUNTANT, key)).toBe(
        true,
      );
    }
  });

  it('only reference keys that exist in the catalog', () => {
    const keys = new Set<string>(REPORT_CATALOG.map((r) => r.key));
    for (const k of SALES_REPORT_KEYS) expect(keys.has(k)).toBe(true);
  });
});
