-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('STAFF', 'ONLINE');

-- CreateEnum
CREATE TYPE "AcceptanceStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "channel" "OrderChannel" NOT NULL DEFAULT 'STAFF',
ADD COLUMN "acceptance" "AcceptanceStatus" NOT NULL DEFAULT 'NOT_REQUIRED';

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN "channel" "OrderChannel" NOT NULL DEFAULT 'STAFF';

-- AlterTable
ALTER TABLE "branches" ADD COLUMN "autoConfirmOrders" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "autoConfirmReservations" BOOLEAN NOT NULL DEFAULT false;
