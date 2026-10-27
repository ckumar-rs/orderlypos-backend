-- Order flow hardening. All additive: nothing is dropped, rewritten or reset,
-- and every new column is nullable so existing orders/payments stay valid.

-- A kitchen-declined ticket is its own state (CANCELLED stays "order withdrawn").
ALTER TYPE "KotStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

CREATE TYPE "CancelSource" AS ENUM ('STAFF', 'CUSTOMER', 'KITCHEN_REJECTED', 'ONLINE_DECLINED');
CREATE TYPE "ManualDiscountType" AS ENUM ('PERCENT', 'FIXED');

ALTER TABLE "orders"
  ADD COLUMN "cancelSource" "CancelSource",
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "acceptedById" TEXT,
  ADD COLUMN "discountType" "ManualDiscountType",
  ADD COLUMN "discountValue" DECIMAL(12,2);

ALTER TABLE "kots"
  ADD COLUMN "acceptedById" TEXT,
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedById" TEXT,
  ADD COLUMN "rejectReason" TEXT;

ALTER TABLE "payments"
  ADD COLUMN "tendered" DECIMAL(12,2),
  ADD COLUMN "changeGiven" DECIMAL(12,2),
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "clientRequestId" TEXT;

CREATE UNIQUE INDEX "payments_orderId_clientRequestId_key" ON "payments"("orderId", "clientRequestId");

-- Accepting / declining incoming orders is now its own permission, so the
-- kitchen and counter staff who actually see the order can answer it (before,
-- accepting needed orders.edit and declining needed orders.cancel, which the
-- kitchen role never held). Backfilled once, like the read permissions: any
-- role that could already work orders or the kitchen keeps being able to.
INSERT INTO "permissions" ("id", "key", "label", "category") VALUES
  ('perm_orders_accept', 'orders.accept', 'Accept / Decline Incoming Orders', 'Orders')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT DISTINCT rp."roleId", v."id"
FROM "role_permissions" rp
JOIN "permissions" held ON held."id" = rp."permissionId"
JOIN "roles" r ON r."id" = rp."roleId"
JOIN "permissions" v ON v."key" = 'orders.accept'
WHERE held."key" IN ('orders.cancel', 'kds.manage')
   OR (held."key" = 'orders.edit' AND r."name" <> 'DELIVERY_STAFF')
ON CONFLICT DO NOTHING;
