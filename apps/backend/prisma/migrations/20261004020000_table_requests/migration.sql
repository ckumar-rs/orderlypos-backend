-- CreateEnum
CREATE TYPE "TableRequestType" AS ENUM ('WAITER', 'BILL');

-- CreateTable
CREATE TABLE "table_requests" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "type" "TableRequestType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "table_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "table_requests_branchId_resolvedAt_idx" ON "table_requests"("branchId", "resolvedAt");

-- CreateIndex
CREATE INDEX "table_requests_tableId_type_resolvedAt_idx" ON "table_requests"("tableId", "type", "resolvedAt");

-- AddForeignKey
ALTER TABLE "table_requests" ADD CONSTRAINT "table_requests_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
