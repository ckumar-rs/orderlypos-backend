-- AlterTable
ALTER TABLE "orders" ADD COLUMN "payToken" TEXT,
ADD COLUMN "payTokenExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "orders_payToken_key" ON "orders"("payToken");
