-- Guest CRM: append-only notes + staff follow-ups (Twenty-like timeline slice).
CREATE TABLE IF NOT EXISTS "customer_notes" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "customer_follow_ups" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "dueAt" TIMESTAMP(3),
  "doneAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "completedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_follow_ups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "customer_notes_customerId_createdAt_idx" ON "customer_notes"("customerId", "createdAt");
CREATE INDEX IF NOT EXISTS "customer_notes_branchId_idx" ON "customer_notes"("branchId");
CREATE INDEX IF NOT EXISTS "customer_follow_ups_customerId_doneAt_dueAt_idx" ON "customer_follow_ups"("customerId", "doneAt", "dueAt");
CREATE INDEX IF NOT EXISTS "customer_follow_ups_branchId_doneAt_dueAt_idx" ON "customer_follow_ups"("branchId", "doneAt", "dueAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_notes_customerId_fkey') THEN
    ALTER TABLE "customer_notes"
      ADD CONSTRAINT "customer_notes_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_notes_branchId_fkey') THEN
    ALTER TABLE "customer_notes"
      ADD CONSTRAINT "customer_notes_branchId_fkey"
      FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_notes_createdByUserId_fkey') THEN
    ALTER TABLE "customer_notes"
      ADD CONSTRAINT "customer_notes_createdByUserId_fkey"
      FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_follow_ups_customerId_fkey') THEN
    ALTER TABLE "customer_follow_ups"
      ADD CONSTRAINT "customer_follow_ups_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_follow_ups_branchId_fkey') THEN
    ALTER TABLE "customer_follow_ups"
      ADD CONSTRAINT "customer_follow_ups_branchId_fkey"
      FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_follow_ups_createdByUserId_fkey') THEN
    ALTER TABLE "customer_follow_ups"
      ADD CONSTRAINT "customer_follow_ups_createdByUserId_fkey"
      FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_follow_ups_completedByUserId_fkey') THEN
    ALTER TABLE "customer_follow_ups"
      ADD CONSTRAINT "customer_follow_ups_completedByUserId_fkey"
      FOREIGN KEY ("completedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
