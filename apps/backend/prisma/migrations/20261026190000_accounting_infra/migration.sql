-- Tally XML Server target and branch-sync HQ (all stored, no hardcoded hosts)
ALTER TABLE "restaurants" ADD COLUMN "tallyHost" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "tallyPort" INTEGER;
ALTER TABLE "restaurants" ADD COLUMN "tallyUseHttps" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "syncEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "syncHqUrl" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "syncHqTokenSealed" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "syncIntervalSec" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "restaurants" ADD COLUMN "syncLastAt" TIMESTAMP(3);
ALTER TABLE "restaurants" ADD COLUMN "syncLastError" TEXT;

CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

CREATE TABLE "ledger_accounts" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "AccountType" NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ledger_accounts_branchId_code_key" ON "ledger_accounts"("branchId", "code");
CREATE INDEX "ledger_accounts_branchId_idx" ON "ledger_accounts"("branchId");
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ledger_account_maps" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  CONSTRAINT "ledger_account_maps_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ledger_account_maps_branchId_sourceKey_key" ON "ledger_account_maps"("branchId", "sourceKey");
ALTER TABLE "ledger_account_maps" ADD CONSTRAINT "ledger_account_maps_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ledger_account_maps" ADD CONSTRAINT "ledger_account_maps_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "journal_vouchers" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "postedOn" DATE NOT NULL,
  "narration" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
  "sourceId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_vouchers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "journal_vouchers_branchId_number_key" ON "journal_vouchers"("branchId", "number");
CREATE INDEX "journal_vouchers_branchId_postedOn_idx" ON "journal_vouchers"("branchId", "postedOn");
ALTER TABLE "journal_vouchers" ADD CONSTRAINT "journal_vouchers_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "journal_lines" (
  "id" TEXT NOT NULL,
  "voucherId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "debit" DECIMAL(12,2) NOT NULL,
  "credit" DECIMAL(12,2) NOT NULL,
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "journal_lines_accountId_idx" ON "journal_lines"("accountId");
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_voucherId_fkey"
  FOREIGN KEY ("voucherId") REFERENCES "journal_vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "tally_posts" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "fromDate" DATE NOT NULL,
  "toDate" DATE NOT NULL,
  "status" TEXT NOT NULL,
  "voucherCount" INTEGER NOT NULL DEFAULT 0,
  "response" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tally_posts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tally_posts_branchId_createdAt_idx" ON "tally_posts"("branchId", "createdAt");
ALTER TABLE "tally_posts" ADD CONSTRAINT "tally_posts_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tally_posts" ADD CONSTRAINT "tally_posts_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "sync_outbox" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "syncedAt" TIMESTAMP(3),
  CONSTRAINT "sync_outbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sync_outbox_branchId_entityType_entityId_key"
  ON "sync_outbox"("branchId", "entityType", "entityId");
CREATE INDEX "sync_outbox_branchId_syncedAt_idx" ON "sync_outbox"("branchId", "syncedAt");
ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "hq_sync_events" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "sourceBranchId" TEXT NOT NULL,
  "sourceBranchName" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "payload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hq_sync_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "hq_sync_events_restaurantId_sourceBranchId_entityType_entityId_key"
  ON "hq_sync_events"("restaurantId", "sourceBranchId", "entityType", "entityId");
CREATE INDEX "hq_sync_events_restaurantId_receivedAt_idx" ON "hq_sync_events"("restaurantId", "receivedAt");
ALTER TABLE "hq_sync_events" ADD CONSTRAINT "hq_sync_events_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
