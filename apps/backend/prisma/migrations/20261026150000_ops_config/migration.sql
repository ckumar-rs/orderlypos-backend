ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "smtpHost" TEXT;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "smtpPort" INTEGER;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "smtpUser" TEXT;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "smtpPasswordSealed" TEXT;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "smtpFrom" TEXT;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "smtpSecure" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "tallyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "tallyCompanyName" TEXT;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "payCash" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "payCard" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "payUpi" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "payOther" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "receiptWhatsApp" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "receiptEmailEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "receiptPrint" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "employeeDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "reservationMessage" TEXT;

CREATE TABLE IF NOT EXISTS "tally_ledgers" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "ledgerName" TEXT NOT NULL,
  CONSTRAINT "tally_ledgers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tally_ledgers_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "tally_ledgers_restaurantId_sourceKey_key" ON "tally_ledgers"("restaurantId", "sourceKey");

CREATE TABLE IF NOT EXISTS "menu_item_sizes" (
  "id" TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "price" DECIMAL(12,2) NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "menu_item_sizes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "menu_item_sizes_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "menu_item_sizes_menuItemId_idx" ON "menu_item_sizes"("menuItemId");

ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "sizeName" TEXT;
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "depositPaid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "depositReference" TEXT;
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "buyQuantity" INTEGER;
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "getQuantity" INTEGER;
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "audience" TEXT NOT NULL DEFAULT 'ALL';

ALTER TYPE "DiscountKind" ADD VALUE IF NOT EXISTS 'BOGO';
