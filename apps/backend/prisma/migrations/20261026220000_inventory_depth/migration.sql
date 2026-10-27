ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'PRODUCTION';

CREATE TYPE "StockCountStatus" AS ENUM ('DRAFT', 'POSTED');

CREATE TABLE "stock_counts" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "countNumber" TEXT NOT NULL,
  "status" "StockCountStatus" NOT NULL DEFAULT 'DRAFT',
  "notes" TEXT,
  "countedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "postedAt" TIMESTAMP(3),
  "countedById" TEXT NOT NULL,
  CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_counts_branchId_countNumber_key" ON "stock_counts"("branchId", "countNumber");
CREATE INDEX "stock_counts_branchId_status_idx" ON "stock_counts"("branchId", "status");
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_countedById_fkey"
  FOREIGN KEY ("countedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "stock_count_lines" (
  "id" TEXT NOT NULL,
  "stockCountId" TEXT NOT NULL,
  "ingredientId" TEXT NOT NULL,
  "expectedQty" DECIMAL(12,3) NOT NULL,
  "countedQty" DECIMAL(12,3) NOT NULL,
  CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_count_lines_stockCountId_ingredientId_key" ON "stock_count_lines"("stockCountId", "ingredientId");
CREATE INDEX "stock_count_lines_stockCountId_idx" ON "stock_count_lines"("stockCountId");
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_stockCountId_fkey"
  FOREIGN KEY ("stockCountId") REFERENCES "stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_ingredientId_fkey"
  FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "prep_recipes" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "outputIngredientId" TEXT NOT NULL,
  "outputQuantity" DECIMAL(12,3) NOT NULL,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prep_recipes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "prep_recipes_branchId_idx" ON "prep_recipes"("branchId");
ALTER TABLE "prep_recipes" ADD CONSTRAINT "prep_recipes_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prep_recipes" ADD CONSTRAINT "prep_recipes_outputIngredientId_fkey"
  FOREIGN KEY ("outputIngredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "prep_recipe_lines" (
  "id" TEXT NOT NULL,
  "prepRecipeId" TEXT NOT NULL,
  "ingredientId" TEXT NOT NULL,
  "quantity" DECIMAL(12,3) NOT NULL,
  CONSTRAINT "prep_recipe_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prep_recipe_lines_prepRecipeId_ingredientId_key" ON "prep_recipe_lines"("prepRecipeId", "ingredientId");
CREATE INDEX "prep_recipe_lines_prepRecipeId_idx" ON "prep_recipe_lines"("prepRecipeId");
ALTER TABLE "prep_recipe_lines" ADD CONSTRAINT "prep_recipe_lines_prepRecipeId_fkey"
  FOREIGN KEY ("prepRecipeId") REFERENCES "prep_recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prep_recipe_lines" ADD CONSTRAINT "prep_recipe_lines_ingredientId_fkey"
  FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "prep_batches" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "prepRecipeId" TEXT NOT NULL,
  "outputIngredientId" TEXT NOT NULL,
  "batchNumber" TEXT NOT NULL,
  "batchMultiplier" DECIMAL(12,3) NOT NULL,
  "quantityProduced" DECIMAL(12,3) NOT NULL,
  "notes" TEXT,
  "producedById" TEXT NOT NULL,
  "producedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prep_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prep_batches_branchId_batchNumber_key" ON "prep_batches"("branchId", "batchNumber");
CREATE INDEX "prep_batches_branchId_idx" ON "prep_batches"("branchId");
ALTER TABLE "prep_batches" ADD CONSTRAINT "prep_batches_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prep_batches" ADD CONSTRAINT "prep_batches_prepRecipeId_fkey"
  FOREIGN KEY ("prepRecipeId") REFERENCES "prep_recipes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prep_batches" ADD CONSTRAINT "prep_batches_outputIngredientId_fkey"
  FOREIGN KEY ("outputIngredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prep_batches" ADD CONSTRAINT "prep_batches_producedById_fkey"
  FOREIGN KEY ("producedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "prep_batch_lines" (
  "id" TEXT NOT NULL,
  "prepBatchId" TEXT NOT NULL,
  "ingredientId" TEXT NOT NULL,
  "quantityConsumed" DECIMAL(12,3) NOT NULL,
  CONSTRAINT "prep_batch_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "prep_batch_lines_prepBatchId_idx" ON "prep_batch_lines"("prepBatchId");
ALTER TABLE "prep_batch_lines" ADD CONSTRAINT "prep_batch_lines_prepBatchId_fkey"
  FOREIGN KEY ("prepBatchId") REFERENCES "prep_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prep_batch_lines" ADD CONSTRAINT "prep_batch_lines_ingredientId_fkey"
  FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements" ADD COLUMN "stockCountId" TEXT;
ALTER TABLE "stock_movements" ADD COLUMN "prepBatchId" TEXT;
CREATE INDEX "stock_movements_stockCountId_idx" ON "stock_movements"("stockCountId");
CREATE INDEX "stock_movements_prepBatchId_idx" ON "stock_movements"("prepBatchId");
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_stockCountId_fkey"
  FOREIGN KEY ("stockCountId") REFERENCES "stock_counts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_prepBatchId_fkey"
  FOREIGN KEY ("prepBatchId") REFERENCES "prep_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
