-- Self-service kiosk: per-branch opaque kiosk token + which service modes
-- the start screen offers, and an idempotency key on orders so a retried
-- public submit can never create a second order. All additive.
ALTER TABLE "branches" ADD COLUMN "kioskToken" TEXT;
ALTER TABLE "branches" ADD COLUMN "kioskDineInEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "branches" ADD COLUMN "kioskTakeawayEnabled" BOOLEAN NOT NULL DEFAULT true;
CREATE UNIQUE INDEX "branches_kioskToken_key" ON "branches"("kioskToken");

ALTER TABLE "orders" ADD COLUMN "clientRequestId" TEXT;
CREATE UNIQUE INDEX "orders_branchId_clientRequestId_key" ON "orders"("branchId", "clientRequestId");
