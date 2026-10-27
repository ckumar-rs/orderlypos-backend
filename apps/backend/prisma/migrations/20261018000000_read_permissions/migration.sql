-- One-time backfill for the read-only permissions (menu.view, tables.view) and
-- the dedicated dashboard.sales.view permission. Runs once (migrations are
-- recorded), so a grant an owner later revokes is never silently re-added.
-- Labels/categories are refreshed by PermissionsSyncService at boot.

INSERT INTO "permissions" ("id", "key", "label", "category") VALUES
  ('perm_menu_view', 'menu.view', 'View Menu (read-only)', 'Menu'),
  ('perm_tables_view', 'tables.view', 'View Floors & Tables (read-only)', 'Tables'),
  ('perm_dashboard_sales_view', 'dashboard.sales.view', 'View Dashboard Revenue & Sales Reports', 'Sales')
ON CONFLICT ("key") DO NOTHING;

-- Any role (system or custom) that could already read the menu / floor plan
-- through orders.create or a manage permission keeps that access.
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT DISTINCT rp."roleId", v."id"
FROM "role_permissions" rp
JOIN "permissions" held ON held."id" = rp."permissionId"
JOIN "permissions" v ON v."key" = 'menu.view'
WHERE held."key" IN ('orders.create', 'menu.manage')
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT DISTINCT rp."roleId", v."id"
FROM "role_permissions" rp
JOIN "permissions" held ON held."id" = rp."permissionId"
JOIN "permissions" v ON v."key" = 'tables.view'
WHERE held."key" IN ('orders.create', 'tables.manage')
ON CONFLICT DO NOTHING;

-- Dashboard revenue/trends: only the four default roles. Custom roles and
-- RESTAURANT_MANAGER get nothing automatically; owners can assign it per role.
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", v."id"
FROM "roles" r
JOIN "permissions" v ON v."key" = 'dashboard.sales.view'
WHERE r."isSystem" = true
  AND r."name" IN ('OWNER', 'ADMINISTRATOR', 'ACCOUNTANT', 'CASHIER')
ON CONFLICT DO NOTHING;

-- Waiters now read the floor plan through tables.view and still update table
-- status / resolve requests (tables.view + orders.edit). The old default also
-- gave the system WAITER role tables.manage, which allows creating, moving and
-- deleting tables and floors; take that one grant back. Custom roles are left
-- alone, and an owner can re-grant it per role in Settings -> Roles.
DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."roleId" = r."id"
  AND rp."permissionId" = p."id"
  AND r."isSystem" = true
  AND r."name" = 'WAITER'
  AND p."key" = 'tables.manage';
