-- Inbound Zomato / Swiggy order intake. Additive: existing orders keep
-- null platform fields, and Postgres treats those nulls as distinct so the
-- new unique index does not collide with tickets that did not come from a platform.
CREATE TYPE "FoodPlatform" AS ENUM ('ZOMATO', 'SWIGGY');

ALTER TABLE "orders" ADD COLUMN "foodPlatform" "FoodPlatform",
ADD COLUMN "externalOrderId" TEXT;

CREATE UNIQUE INDEX "orders_branchId_foodPlatform_externalOrderId_key" ON "orders"("branchId", "foodPlatform", "externalOrderId");

CREATE TABLE "food_platform_intakes" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "platform" "FoodPlatform" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "outletId" TEXT,
    "secretHash" TEXT NOT NULL,
    "secretSealed" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_platform_intakes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "food_platform_intakes_secretHash_key" ON "food_platform_intakes"("secretHash");
CREATE UNIQUE INDEX "food_platform_intakes_branchId_platform_key" ON "food_platform_intakes"("branchId", "platform");

ALTER TABLE "food_platform_intakes" ADD CONSTRAINT "food_platform_intakes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
