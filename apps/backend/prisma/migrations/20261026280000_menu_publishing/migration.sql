ALTER TABLE "menu_sets" ADD COLUMN "startsOn" TEXT;
ALTER TABLE "menu_sets" ADD COLUMN "endsOn" TEXT;

CREATE TABLE "menu_price_rules" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "menuItemId" TEXT,
    "categoryId" TEXT,
    "ingredientId" TEXT,
    "percent" DECIMAL(6,2) NOT NULL,
    "daysOfWeek" INTEGER[] NOT NULL,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "stockBelow" DECIMAL(12,3),
    "demandQty" INTEGER,
    "demandHours" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "menu_price_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "menu_price_rules_branchId_isActive_idx" ON "menu_price_rules"("branchId", "isActive");

ALTER TABLE "menu_price_rules" ADD CONSTRAINT "menu_price_rules_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
