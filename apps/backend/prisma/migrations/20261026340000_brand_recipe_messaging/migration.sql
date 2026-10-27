ALTER TABLE "recipe_revisions" ADD COLUMN "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TYPE "OutboundChannel" ADD VALUE IF NOT EXISTS 'EMAIL';
ALTER TYPE "OutboundStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "OutboundStatus" ADD VALUE IF NOT EXISTS 'OPTED_OUT';

ALTER TABLE "outbound_messages" ADD COLUMN "deliveredAt" TIMESTAMP(3);
CREATE INDEX "outbound_messages_providerRef_idx" ON "outbound_messages"("providerRef");

CREATE TABLE "message_opt_outs" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "channel" "OutboundChannel" NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_opt_outs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "message_opt_outs_restaurantId_channel_address_key" ON "message_opt_outs"("restaurantId", "channel", "address");
ALTER TABLE "message_opt_outs" ADD CONSTRAINT "message_opt_outs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "brands" ADD COLUMN "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "brands" ADD COLUMN "upiVpa" TEXT;

CREATE TABLE "brand_menu_items" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "categoryName" TEXT NOT NULL DEFAULT 'Menu',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "brand_menu_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "brand_menu_items_brandId_name_key" ON "brand_menu_items"("brandId", "name");
ALTER TABLE "brand_menu_items" ADD CONSTRAINT "brand_menu_items_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "menu_items" ADD COLUMN "brandItemId" TEXT;
CREATE INDEX "menu_items_brandItemId_idx" ON "menu_items"("brandItemId");
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_brandItemId_fkey" FOREIGN KEY ("brandItemId") REFERENCES "brand_menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reservations" ADD COLUMN "feeChargeUrl" TEXT;
ALTER TABLE "reservations" ADD COLUMN "feeChargeRef" TEXT;
ALTER TABLE "reservations" ADD COLUMN "feeChargeStatus" TEXT;
ALTER TABLE "reservations" ADD COLUMN "feeChargeProvider" TEXT;
