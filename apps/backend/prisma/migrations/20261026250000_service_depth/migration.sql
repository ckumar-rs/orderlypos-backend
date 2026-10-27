ALTER TABLE "restaurants" ADD COLUMN "targetFoodCostPercent" DECIMAL(5,2) NOT NULL DEFAULT 30;
ALTER TABLE "restaurants" ADD COLUMN "noShowFee" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "restaurants" ADD COLUMN "approvalDiscountAbove" DECIMAL(5,2);
ALTER TABLE "restaurants" ADD COLUMN "approvalForVoid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "approvalForRefund" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "floors" ADD COLUMN "seating" TEXT NOT NULL DEFAULT 'INDOOR';
ALTER TABLE "orders" ADD COLUMN "partyName" TEXT;
ALTER TABLE "orders" ADD COLUMN "curbside" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "vehicleNote" TEXT;
ALTER TABLE "orders" ADD COLUMN "source" TEXT;
ALTER TABLE "branches" ADD COLUMN "brandId" TEXT;

CREATE TABLE "brands" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "brands_restaurantId_name_key" ON "brands"("restaurantId", "name");
ALTER TABLE "brands" ADD CONSTRAINT "brands_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branches" ADD CONSTRAINT "branches_brandId_fkey"
  FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "exchange_rates" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "rateToBase" DECIMAL(12,6) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "exchange_rates_restaurantId_currency_key" ON "exchange_rates"("restaurantId", "currency");
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "installed_apps" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "baseUrl" TEXT,
  "secretSealed" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "installed_apps_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "installed_apps_restaurantId_idx" ON "installed_apps"("restaurantId");
ALTER TABLE "installed_apps" ADD CONSTRAINT "installed_apps_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "whatsapp_intakes" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "secretHash" TEXT NOT NULL,
  "secretSealed" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_intakes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "whatsapp_intakes_branchId_key" ON "whatsapp_intakes"("branchId");
CREATE UNIQUE INDEX "whatsapp_intakes_secretHash_key" ON "whatsapp_intakes"("secretHash");
ALTER TABLE "whatsapp_intakes" ADD CONSTRAINT "whatsapp_intakes_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "till_sessions" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "openingFloat" DECIMAL(12,2) NOT NULL,
  "expectedCash" DECIMAL(12,2),
  "countedCash" DECIMAL(12,2),
  "note" TEXT,
  "openedById" TEXT NOT NULL,
  "closedById" TEXT,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "till_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "till_sessions_branchId_openedAt_idx" ON "till_sessions"("branchId", "openedAt");
ALTER TABLE "till_sessions" ADD CONSTRAINT "till_sessions_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "till_sessions" ADD CONSTRAINT "till_sessions_openedById_fkey"
  FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "till_sessions" ADD CONSTRAINT "till_sessions_closedById_fkey"
  FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "approval_requests" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "orderId" TEXT,
  "kind" TEXT NOT NULL,
  "note" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT NOT NULL,
  "decidedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "approval_requests_branchId_status_idx" ON "approval_requests"("branchId", "status");
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "recipe_revisions" (
  "id" TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  "foodCost" DECIMAL(12,2) NOT NULL,
  "sellingPrice" DECIMAL(12,2) NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recipe_revisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "recipe_revisions_menuItemId_createdAt_idx" ON "recipe_revisions"("menuItemId", "createdAt");
ALTER TABLE "recipe_revisions" ADD CONSTRAINT "recipe_revisions_menuItemId_fkey"
  FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
