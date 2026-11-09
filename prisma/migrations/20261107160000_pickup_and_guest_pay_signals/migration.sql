-- Guest pay signals from the table QR (I paid / want COD).
ALTER TYPE "TableRequestType" ADD VALUE IF NOT EXISTS 'PAID_CLAIM';
ALTER TYPE "TableRequestType" ADD VALUE IF NOT EXISTS 'COD';

-- Public takeaway / kiosk pickup queue board token.
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "pickupDisplayToken" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "branches_pickupDisplayToken_key" ON "branches"("pickupDisplayToken");

-- Admin Settings toggles (off until the owner turns them on).
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "payBeforeKitchenKiosk" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "payBeforeKitchenTakeaway" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "guestPaidClaimEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "guestCodRequestEnabled" BOOLEAN NOT NULL DEFAULT false;
