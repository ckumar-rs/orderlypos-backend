ALTER TABLE "menu_items" ADD COLUMN "servings" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "menu_items" ADD COLUMN "yieldQuantity" DECIMAL(12,3);
ALTER TABLE "menu_items" ADD COLUMN "yieldUnit" TEXT;
ALTER TABLE "menu_items" ADD COLUMN "instructions" TEXT;
ALTER TABLE "menu_items" ADD COLUMN "portionStep" DECIMAL(8,3) NOT NULL DEFAULT 1;

ALTER TABLE "order_items" ADD COLUMN "portionFactor" DECIMAL(8,3) NOT NULL DEFAULT 1;

ALTER TABLE "recipe_ingredients" ADD COLUMN "unit" "IngredientUnit";

ALTER TABLE "recipe_revisions" ADD COLUMN "servings" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "recipe_revisions" ADD COLUMN "yieldQuantity" DECIMAL(12,3);
ALTER TABLE "recipe_revisions" ADD COLUMN "yieldUnit" TEXT;
ALTER TABLE "recipe_revisions" ADD COLUMN "instructions" TEXT;
ALTER TABLE "recipe_revisions" ADD COLUMN "lines" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "unit_conversions" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "fromUnit" "IngredientUnit" NOT NULL,
    "toUnit" "IngredientUnit" NOT NULL,
    "factor" DECIMAL(14,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "unit_conversions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "unit_conversions_branchId_fromUnit_toUnit_key" ON "unit_conversions"("branchId", "fromUnit", "toUnit");
CREATE INDEX "unit_conversions_branchId_idx" ON "unit_conversions"("branchId");
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "inventory_alerts" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_alerts_branchId_kind_subjectKey_key" ON "inventory_alerts"("branchId", "kind", "subjectKey");
CREATE INDEX "inventory_alerts_branchId_idx" ON "inventory_alerts"("branchId");
ALTER TABLE "inventory_alerts" ADD CONSTRAINT "inventory_alerts_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
