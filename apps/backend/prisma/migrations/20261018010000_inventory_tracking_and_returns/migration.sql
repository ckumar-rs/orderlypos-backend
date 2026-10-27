-- CreateEnum
CREATE TYPE "InventoryTracking" AS ENUM ('NONE', 'RECIPE', 'DIRECT');

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'REVERSAL';

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN     "inventoryTracking" "InventoryTracking" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "stockIngredientId" TEXT,
ADD COLUMN     "stockQuantityPerSale" DECIMAL(12,3) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "orderId" TEXT;

-- CreateTable
CREATE TABLE "order_item_stock_returns" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_stock_returns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_item_stock_returns_orderItemId_idx" ON "order_item_stock_returns"("orderItemId");

-- CreateIndex
CREATE INDEX "order_item_stock_returns_refundId_idx" ON "order_item_stock_returns"("refundId");

-- CreateIndex
CREATE INDEX "stock_movements_orderId_idx" ON "stock_movements"("orderId");

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_stockIngredientId_fkey" FOREIGN KEY ("stockIngredientId") REFERENCES "ingredients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_stock_returns" ADD CONSTRAINT "order_item_stock_returns_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_stock_returns" ADD CONSTRAINT "order_item_stock_returns_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep today's behaviour for existing installs: items that already have a
-- recipe stay recipe-tracked; everything else stays untracked (no change).
UPDATE "menu_items" SET "inventoryTracking" = 'RECIPE'
WHERE "id" IN (SELECT DISTINCT "menuItemId" FROM "recipe_ingredients");
