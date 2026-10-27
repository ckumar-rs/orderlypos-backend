ALTER TABLE "promotions" ADD COLUMN "minOrderAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "promotions" ADD COLUMN "customerId" TEXT;
ALTER TABLE "promotions" ADD COLUMN "weatherCode" TEXT;
ALTER TABLE "promotions" ADD COLUMN "bundleMenuItemId" TEXT;
ALTER TABLE "promotions" ADD COLUMN "allDay" BOOLEAN NOT NULL DEFAULT false;
