-- Network (TCP/9100) thermal printers, per-ticket print tracking, and an
-- auditable cancel reason. All additive; existing branches keep USB printing.
ALTER TABLE "branches" ADD COLUMN "printerConnection" TEXT NOT NULL DEFAULT 'USB',
ADD COLUMN "printerHost" TEXT,
ADD COLUMN "printerPort" INTEGER NOT NULL DEFAULT 9100;

ALTER TABLE "kots" ADD COLUMN "printedAt" TIMESTAMP(3),
ADD COLUMN "lastPrintError" TEXT;

ALTER TABLE "orders" ADD COLUMN "cancelReason" TEXT,
ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "cancelledById" TEXT;
