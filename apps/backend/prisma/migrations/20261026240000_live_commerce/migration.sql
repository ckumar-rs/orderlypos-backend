ALTER TABLE "food_platform_intakes" ADD COLUMN "apiBaseUrl" TEXT;
ALTER TABLE "food_platform_intakes" ADD COLUMN "apiKeySealed" TEXT;
ALTER TABLE "food_platform_intakes" ADD COLUMN "storeOpen" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "orders" ADD COLUMN "trackingToken" TEXT;
CREATE UNIQUE INDEX "orders_trackingToken_key" ON "orders"("trackingToken");

ALTER TABLE "payments" ADD COLUMN "gatewayProvider" TEXT;
ALTER TABLE "payments" ADD COLUMN "utr" TEXT;
CREATE INDEX "payments_utr_idx" ON "payments"("utr");

ALTER TABLE "bank_transactions" ADD COLUMN "paymentId" TEXT;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "payment_gateways" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "baseUrl" TEXT,
  "keyId" TEXT,
  "secretSealed" TEXT,
  "webhookSecretSealed" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_gateways_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_gateways_restaurantId_provider_key" ON "payment_gateways"("restaurantId", "provider");
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "payment_intents" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "gatewayRef" TEXT,
  "utr" TEXT,
  "checkoutUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "payment_intents_gatewayRef_idx" ON "payment_intents"("gatewayRef");
CREATE INDEX "payment_intents_orderId_idx" ON "payment_intents"("orderId");
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "edc_terminals" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "baseUrl" TEXT,
  "merchantId" TEXT,
  "terminalId" TEXT,
  "secretSealed" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "edc_terminals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "edc_terminals_branchId_idx" ON "edc_terminals"("branchId");
ALTER TABLE "edc_terminals" ADD CONSTRAINT "edc_terminals_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "house_accounts" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "customerId" TEXT,
  "name" TEXT NOT NULL,
  "creditLimit" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "house_accounts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "house_accounts_branchId_idx" ON "house_accounts"("branchId");
ALTER TABLE "house_accounts" ADD CONSTRAINT "house_accounts_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "house_accounts" ADD CONSTRAINT "house_accounts_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "house_account_entries" (
  "id" TEXT NOT NULL,
  "houseAccountId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "reference" TEXT,
  "orderId" TEXT,
  "reservationId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "house_account_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "house_account_entries_houseAccountId_idx" ON "house_account_entries"("houseAccountId");
ALTER TABLE "house_account_entries" ADD CONSTRAINT "house_account_entries_houseAccountId_fkey"
  FOREIGN KEY ("houseAccountId") REFERENCES "house_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "house_account_entries" ADD CONSTRAINT "house_account_entries_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "driver_pings" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "lat" DECIMAL(9,6) NOT NULL,
  "lng" DECIMAL(9,6) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_pings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "driver_pings_orderId_recordedAt_idx" ON "driver_pings"("orderId", "recordedAt");
ALTER TABLE "driver_pings" ADD CONSTRAINT "driver_pings_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "fleet_accounts" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "baseUrl" TEXT,
  "apiKeySealed" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fleet_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "fleet_accounts_branchId_provider_key" ON "fleet_accounts"("branchId", "provider");
ALTER TABLE "fleet_accounts" ADD CONSTRAINT "fleet_accounts_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "fleet_jobs" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fleet_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "fleet_jobs_externalId_idx" ON "fleet_jobs"("externalId");
CREATE INDEX "fleet_jobs_orderId_idx" ON "fleet_jobs"("orderId");
ALTER TABLE "fleet_jobs" ADD CONSTRAINT "fleet_jobs_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
