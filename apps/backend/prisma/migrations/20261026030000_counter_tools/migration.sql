ALTER TABLE "menu_items" ADD COLUMN "soldByWeight" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "menu_items_branchId_barcode_key" ON "menu_items"("branchId", "barcode");

ALTER TABLE "orders" ADD COLUMN "driverLat" DECIMAL(9,6);
ALTER TABLE "orders" ADD COLUMN "driverLng" DECIMAL(9,6);
ALTER TABLE "orders" ADD COLUMN "driverLocationAt" TIMESTAMP(3);

ALTER TABLE "order_items" ADD COLUMN "weightKg" DECIMAL(8,3);

ALTER TABLE "payroll_lines" ADD COLUMN "pfEmployee" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "payroll_lines" ADD COLUMN "pfEmployer" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "payroll_lines" ADD COLUMN "esiEmployee" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "payroll_lines" ADD COLUMN "esiEmployer" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "payroll_lines" ADD COLUMN "tds" DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE TYPE "ExpenseApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
ALTER TABLE "expenses" ADD COLUMN "status" "ExpenseApprovalStatus" NOT NULL DEFAULT 'APPROVED';
ALTER TABLE "expenses" ADD COLUMN "decidedById" TEXT;
ALTER TABLE "expenses" ADD COLUMN "decidedAt" TIMESTAMP(3);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "PettyCashDirection" AS ENUM ('IN', 'OUT');
CREATE TABLE "petty_cash_entries" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "direction" "PettyCashDirection" NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "reason" TEXT NOT NULL,
  "spentOn" DATE NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "petty_cash_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "petty_cash_entries_branchId_spentOn_idx" ON "petty_cash_entries"("branchId", "spentOn");
ALTER TABLE "petty_cash_entries" ADD CONSTRAINT "petty_cash_entries_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "petty_cash_entries" ADD CONSTRAINT "petty_cash_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
