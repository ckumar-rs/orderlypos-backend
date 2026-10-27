ALTER TABLE "reservations" ADD COLUMN "depositStatus" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "reservations" ADD COLUMN "depositMethod" TEXT;
ALTER TABLE "reservations" ADD COLUMN "feeCharged" DECIMAL(12,2) NOT NULL DEFAULT 0;
