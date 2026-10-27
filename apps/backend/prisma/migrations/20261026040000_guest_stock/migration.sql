-- Guest bills, stock units, membership, and India tax fields.

ALTER TABLE "restaurants" ADD COLUMN "referralPoints" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "restaurants" ADD COLUMN "birthdayDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "restaurants" ADD COLUMN "fssaiNumber" TEXT;

ALTER TABLE "branches" ADD COLUMN "gstStateCode" TEXT;
ALTER TABLE "branches" ADD COLUMN "serviceChargePercent" DECIMAL(5,2) NOT NULL DEFAULT 0;

ALTER TABLE "ingredients" ADD COLUMN "purchaseToBase" DECIMAL(12,3) NOT NULL DEFAULT 1;

ALTER TABLE "menu_items" ADD COLUMN "hsnCode" TEXT;

ALTER TABLE "customers" ADD COLUMN "referralCode" TEXT;
ALTER TABLE "customers" ADD COLUMN "referredById" TEXT;
ALTER TABLE "customers" ADD COLUMN "referralRewarded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customers" ADD COLUMN "birthdayOfferYear" INTEGER;
ALTER TABLE "customers" ADD COLUMN "gstStateCode" TEXT;
ALTER TABLE "customers" ADD COLUMN "tierId" TEXT;

CREATE UNIQUE INDEX "customers_referralCode_key" ON "customers"("referralCode");

CREATE TABLE "membership_tiers" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minPoints" INTEGER NOT NULL DEFAULT 0,
    "earnMultiplier" DECIMAL(6,2) NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "membership_tiers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "membership_tiers_restaurantId_name_key" ON "membership_tiers"("restaurantId", "name");
CREATE INDEX "membership_tiers_restaurantId_idx" ON "membership_tiers"("restaurantId");

ALTER TABLE "membership_tiers" ADD CONSTRAINT "membership_tiers_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "membership_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "orders" ADD COLUMN "serviceChargeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "heldAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "interstate" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "order_items" ADD COLUMN "guestNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "order_items" ADD COLUMN "complimentary" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "order_items" ADD COLUMN "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "order_items" ADD COLUMN "hsnCode" TEXT;

ALTER TYPE "CampaignSegment" ADD VALUE 'TIER';
ALTER TABLE "campaigns" ADD COLUMN "tierId" TEXT;

CREATE TABLE "purchase_returns" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "emailed" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "purchase_returns_branchId_idx" ON "purchase_returns"("branchId");

ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "purchase_return_items" (
    "id" TEXT NOT NULL,
    "purchaseReturnId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    CONSTRAINT "purchase_return_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "purchase_return_items_purchaseReturnId_idx" ON "purchase_return_items"("purchaseReturnId");

ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_purchaseReturnId_fkey" FOREIGN KEY ("purchaseReturnId") REFERENCES "purchase_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
