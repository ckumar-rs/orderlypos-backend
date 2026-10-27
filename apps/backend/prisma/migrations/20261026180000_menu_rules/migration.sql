-- Nested categories
ALTER TABLE "menu_categories" ADD COLUMN "parentId" TEXT;
CREATE INDEX "menu_categories_parentId_idx" ON "menu_categories"("parentId");
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "menu_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Sales channels and per-dish overrides
CREATE TABLE "sales_channels" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "orderType" "OrderType",
  "foodPlatform" "FoodPlatform",
  "markupPercent" DECIMAL(7,2) NOT NULL DEFAULT 0,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "sales_channels_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sales_channels_branchId_idx" ON "sales_channels"("branchId");
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "menu_item_channel_prices" (
  "id" TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "price" DECIMAL(12,2) NOT NULL,
  CONSTRAINT "menu_item_channel_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "menu_item_channel_prices_menuItemId_channelId_key"
  ON "menu_item_channel_prices"("menuItemId", "channelId");
ALTER TABLE "menu_item_channel_prices" ADD CONSTRAINT "menu_item_channel_prices_menuItemId_fkey"
  FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_item_channel_prices" ADD CONSTRAINT "menu_item_channel_prices_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Named menu sets
CREATE TABLE "menu_sets" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isForced" BOOLEAN NOT NULL DEFAULT false,
  "daysOfWeek" INTEGER[] NOT NULL,
  "startMinute" INTEGER,
  "endMinute" INTEGER,
  CONSTRAINT "menu_sets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "menu_sets_branchId_idx" ON "menu_sets"("branchId");
ALTER TABLE "menu_sets" ADD CONSTRAINT "menu_sets_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "menu_set_items" (
  "menuSetId" TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  CONSTRAINT "menu_set_items_pkey" PRIMARY KEY ("menuSetId","menuItemId")
);
ALTER TABLE "menu_set_items" ADD CONSTRAINT "menu_set_items_menuSetId_fkey"
  FOREIGN KEY ("menuSetId") REFERENCES "menu_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_set_items" ADD CONSTRAINT "menu_set_items_menuItemId_fkey"
  FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Order remembers which price list was used
ALTER TABLE "orders" ADD COLUMN "salesChannelId" TEXT;
ALTER TABLE "orders" ADD CONSTRAINT "orders_salesChannelId_fkey"
  FOREIGN KEY ("salesChannelId") REFERENCES "sales_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Category-scoped promotions
ALTER TABLE "promotions" ADD COLUMN "categoryId" TEXT;
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "menu_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
