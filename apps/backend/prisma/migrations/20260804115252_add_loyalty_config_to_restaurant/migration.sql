-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "loyaltyEarnPerCurrency" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "loyaltyPointValue" DECIMAL(6,2) NOT NULL DEFAULT 1;
