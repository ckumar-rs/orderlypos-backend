ALTER TABLE "restaurants" ADD COLUMN "demoMode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "demoPlatformStatus" TEXT;
