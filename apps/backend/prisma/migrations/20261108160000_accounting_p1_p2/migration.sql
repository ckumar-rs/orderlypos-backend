-- Cash drops on day close
ALTER TABLE "cash_closings" ADD COLUMN IF NOT EXISTS "bankDrop" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "cash_closings" ADD COLUMN IF NOT EXISTS "safeDrop" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Expense receipt attachments
CREATE TABLE IF NOT EXISTS "expense_attachments" (
  "id" TEXT NOT NULL,
  "expenseId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "data" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "expense_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "expense_attachments_expenseId_idx" ON "expense_attachments"("expenseId");

DO $$ BEGIN
  ALTER TABLE "expense_attachments"
    ADD CONSTRAINT "expense_attachments_expenseId_fkey"
    FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Accounting period locks
CREATE TABLE IF NOT EXISTS "accounting_period_locks" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "fromDate" DATE NOT NULL,
  "toDate" DATE NOT NULL,
  "reason" TEXT,
  "lockedById" TEXT NOT NULL,
  "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "accounting_period_locks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "accounting_period_locks_branchId_fromDate_toDate_idx"
  ON "accounting_period_locks"("branchId", "fromDate", "toDate");

DO $$ BEGIN
  ALTER TABLE "accounting_period_locks"
    ADD CONSTRAINT "accounting_period_locks_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "accounting_period_locks"
    ADD CONSTRAINT "accounting_period_locks_lockedById_fkey"
    FOREIGN KEY ("lockedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
