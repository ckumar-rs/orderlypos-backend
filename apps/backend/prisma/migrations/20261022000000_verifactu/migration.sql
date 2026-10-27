-- Spain VERI*FACTU: per-branch settings and an append-only, hash-chained record log.
-- Additive. Nothing changes for branches that never enable it.
CREATE TYPE "VerifactuEnvironment" AS ENUM ('TEST', 'PRODUCTION');
CREATE TYPE "VerifactuRecordType" AS ENUM ('ALTA', 'ANULACION');
CREATE TYPE "VerifactuStatus" AS ENUM ('PENDING', 'ACCEPTED', 'ACCEPTED_WITH_ERRORS', 'REJECTED', 'ERROR');

CREATE TABLE "verifactu_settings" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "environment" "VerifactuEnvironment" NOT NULL DEFAULT 'TEST',
  "seriesPrefix" TEXT NOT NULL DEFAULT 'T1',
  "nextNumber" INTEGER NOT NULL DEFAULT 1,
  "nextRefundNumber" INTEGER NOT NULL DEFAULT 1,
  "installationNumber" TEXT NOT NULL,
  "certEncrypted" BYTEA,
  "certPasswordEncrypted" BYTEA,
  "certSubject" TEXT,
  "certExpiresAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verifactu_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "verifactu_settings_branchId_key" ON "verifactu_settings"("branchId");
ALTER TABLE "verifactu_settings" ADD CONSTRAINT "verifactu_settings_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "verifactu_records" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "issuerNif" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "type" "VerifactuRecordType" NOT NULL,
  "invoiceType" TEXT NOT NULL,
  "invoiceNumber" TEXT NOT NULL,
  "issueDate" TEXT NOT NULL,
  "taxTotalCents" INTEGER NOT NULL,
  "totalCents" INTEGER NOT NULL,
  "generatedAt" TEXT NOT NULL,
  "previousHash" TEXT,
  "hash" TEXT NOT NULL,
  "xml" TEXT NOT NULL,
  "qrUrl" TEXT,
  "environment" "VerifactuEnvironment" NOT NULL,
  "orderId" TEXT,
  "refundId" TEXT,
  "status" "VerifactuStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "csv" TEXT,
  "errorCode" TEXT,
  "errorText" TEXT,
  "responseXml" TEXT,
  "submittedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verifactu_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "verifactu_records_chain_key" ON "verifactu_records"("restaurantId", "issuerNif", "environment", "seq");
CREATE UNIQUE INDEX "verifactu_records_number_key" ON "verifactu_records"("restaurantId", "issuerNif", "environment", "invoiceNumber", "type");
CREATE INDEX "verifactu_records_orderId_idx" ON "verifactu_records"("orderId");
CREATE INDEX "verifactu_records_branchId_status_nextAttemptAt_idx" ON "verifactu_records"("branchId", "status", "nextAttemptAt");
ALTER TABLE "verifactu_records" ADD CONSTRAINT "verifactu_records_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The log is append-only. Only the submission outcome columns may change.
CREATE FUNCTION verifactu_records_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev_hash TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verifactu_records is append-only: delete is not allowed';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."restaurantId" IS DISTINCT FROM OLD."restaurantId"
       OR NEW."branchId" IS DISTINCT FROM OLD."branchId" OR NEW."issuerNif" IS DISTINCT FROM OLD."issuerNif"
       OR NEW."seq" IS DISTINCT FROM OLD."seq" OR NEW."type" IS DISTINCT FROM OLD."type"
       OR NEW."invoiceType" IS DISTINCT FROM OLD."invoiceType" OR NEW."invoiceNumber" IS DISTINCT FROM OLD."invoiceNumber"
       OR NEW."issueDate" IS DISTINCT FROM OLD."issueDate" OR NEW."taxTotalCents" IS DISTINCT FROM OLD."taxTotalCents"
       OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents" OR NEW."generatedAt" IS DISTINCT FROM OLD."generatedAt"
       OR NEW."previousHash" IS DISTINCT FROM OLD."previousHash" OR NEW."hash" IS DISTINCT FROM OLD."hash"
       OR NEW."xml" IS DISTINCT FROM OLD."xml" OR NEW."qrUrl" IS DISTINCT FROM OLD."qrUrl"
       OR NEW."environment" IS DISTINCT FROM OLD."environment" OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
       OR NEW."refundId" IS DISTINCT FROM OLD."refundId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'verifactu_records is append-only: only the submission outcome may change';
    END IF;
    RETURN NEW;
  END IF;
  -- INSERT: the record must continue the issuer's chain exactly.
  IF NEW."seq" = 1 THEN
    IF NEW."previousHash" IS NOT NULL THEN
      RAISE EXCEPTION 'verifactu_records: the first record of a chain has no previous hash';
    END IF;
  ELSE
    SELECT "hash" INTO prev_hash FROM "verifactu_records"
     WHERE "restaurantId" = NEW."restaurantId" AND "issuerNif" = NEW."issuerNif"
       AND "environment" = NEW."environment" AND "seq" = NEW."seq" - 1;
    IF prev_hash IS NULL OR prev_hash IS DISTINCT FROM NEW."previousHash" THEN
      RAISE EXCEPTION 'verifactu_records: record % does not continue the chain', NEW."seq";
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER verifactu_records_guard BEFORE INSERT OR UPDATE OR DELETE ON "verifactu_records"
  FOR EACH ROW EXECUTE FUNCTION verifactu_records_guard();

CREATE FUNCTION verifactu_records_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'verifactu_records is append-only: truncate is not allowed'; END $$;
CREATE TRIGGER verifactu_records_no_truncate BEFORE TRUNCATE ON "verifactu_records"
  FOR EACH STATEMENT EXECUTE FUNCTION verifactu_records_no_truncate();
