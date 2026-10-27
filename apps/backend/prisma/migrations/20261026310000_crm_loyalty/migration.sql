ALTER TABLE "customers" ADD COLUMN "cashbackBalance" DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE TABLE "loyalty_rules" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "earnPerCurrency" INTEGER,
    "pointValue" DECIMAL(6,2),
    "maxEarnPerOrder" INTEGER,
    "maxRedeemPerOrder" INTEGER,
    "expiryDays" INTEGER,
    "eligibleMenuItemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cashbackPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cashbackCap" DECIMAL(12,2),
    CONSTRAINT "loyalty_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "loyalty_rules_branchId_key" ON "loyalty_rules"("branchId");
ALTER TABLE "loyalty_rules" ADD CONSTRAINT "loyalty_rules_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "point_lots" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "pointsRemaining" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "point_lots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "point_lots_customerId_idx" ON "point_lots"("customerId");
ALTER TABLE "point_lots" ADD CONSTRAINT "point_lots_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "rewards" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pointsCost" INTEGER NOT NULL DEFAULT 0,
    "cashbackCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rewards_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rewards_branchId_idx" ON "rewards"("branchId");
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "reward_redemptions" (
    "id" TEXT NOT NULL,
    "rewardId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reward_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reward_redemptions_customerId_idx" ON "reward_redemptions"("customerId");
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "rewards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "employee_discounts" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT,
    "roleId" TEXT,
    "percent" DECIMAL(5,2) NOT NULL,
    "maxAmount" DECIMAL(12,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "employee_discounts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "employee_discounts_branchId_idx" ON "employee_discounts"("branchId");
ALTER TABLE "employee_discounts" ADD CONSTRAINT "employee_discounts_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_discounts" ADD CONSTRAINT "employee_discounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_discounts" ADD CONSTRAINT "employee_discounts_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
