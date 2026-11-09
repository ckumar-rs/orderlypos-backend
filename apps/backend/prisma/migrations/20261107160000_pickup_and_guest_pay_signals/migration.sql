-- Guest pay signals from the table QR (I paid / want COD).
ALTER TYPE "TableRequestType" ADD VALUE IF NOT EXISTS 'PAID_CLAIM';
ALTER TYPE "TableRequestType" ADD VALUE IF NOT EXISTS 'COD';

-- Public takeaway / kiosk pickup queue board token.
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "pickupDisplayToken" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "branches_pickupDisplayToken_key" ON "branches"("pickupDisplayToken");

-- Drop branch columns if an earlier draft of this migration added them — settings live in tables below.
ALTER TABLE "branches" DROP COLUMN IF EXISTS "payBeforeKitchenKiosk";
ALTER TABLE "branches" DROP COLUMN IF EXISTS "payBeforeKitchenTakeaway";
ALTER TABLE "branches" DROP COLUMN IF EXISTS "guestPaidClaimEnabled";
ALTER TABLE "branches" DROP COLUMN IF EXISTS "guestCodRequestEnabled";

-- Key/value settings tables (no product flags hardcoded in application code).
CREATE TABLE IF NOT EXISTS "restaurant_settings" (
    "restaurantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "restaurant_settings_pkey" PRIMARY KEY ("restaurantId","key")
);

CREATE TABLE IF NOT EXISTS "branch_settings" (
    "branchId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "branch_settings_pkey" PRIMARY KEY ("branchId","key")
);

DO $$ BEGIN
  ALTER TABLE "restaurant_settings"
    ADD CONSTRAINT "restaurant_settings_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "branch_settings"
    ADD CONSTRAINT "branch_settings_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed defaults for every existing restaurant / branch (editable in Settings).
INSERT INTO "restaurant_settings" ("restaurantId", "key", "value", "updatedAt")
SELECT r."id", v."key", v."value", CURRENT_TIMESTAMP
FROM "restaurants" r
CROSS JOIN (VALUES
  ('preferred_payment_method', 'UPI'),
  ('payment_method_order', 'UPI,CASH,CARD,OTHER'),
  ('cash_label', 'COD')
) AS v("key", "value")
ON CONFLICT ("restaurantId", "key") DO NOTHING;

INSERT INTO "branch_settings" ("branchId", "key", "value", "updatedAt")
SELECT b."id", v."key", v."value", CURRENT_TIMESTAMP
FROM "branches" b
CROSS JOIN (VALUES
  ('pay_before_kitchen_kiosk', 'false'),
  ('pay_before_kitchen_takeaway', 'false'),
  ('guest_paid_claim_enabled', 'false'),
  ('guest_cod_request_enabled', 'false'),
  ('guest_waiter_enabled', 'true'),
  ('guest_bill_enabled', 'true')
) AS v("key", "value")
ON CONFLICT ("branchId", "key") DO NOTHING;
