-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('UNASSIGNED', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'FAILED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "deliveryZoneId" TEXT,
ADD COLUMN "deliveryFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "deliveryAddress" TEXT,
ADD COLUMN "deliveryPincode" TEXT,
ADD COLUMN "deliveryPhone" TEXT,
ADD COLUMN "deliveryStatus" "DeliveryStatus",
ADD COLUMN "driverId" TEXT,
ADD COLUMN "deliveryEtaAt" TIMESTAMP(3),
ADD COLUMN "deliveredAt" TIMESTAMP(3),
ADD COLUMN "scheduledFor" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "delivery_zones" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "minOrderAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "etaMinutes" INTEGER NOT NULL DEFAULT 45,
    "pincodes" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_zones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_zones_branchId_isActive_idx" ON "delivery_zones"("branchId", "isActive");

-- CreateIndex
CREATE INDEX "orders_branchId_deliveryStatus_idx" ON "orders"("branchId", "deliveryStatus");

-- AddForeignKey
ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_deliveryZoneId_fkey" FOREIGN KEY ("deliveryZoneId") REFERENCES "delivery_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
