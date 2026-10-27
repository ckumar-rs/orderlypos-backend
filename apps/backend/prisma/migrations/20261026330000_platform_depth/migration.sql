ALTER TABLE "restaurants" ADD COLUMN "franchisePriceLock" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "ipAllowList" TEXT NOT NULL DEFAULT '';
ALTER TABLE "restaurants" ADD COLUMN "requireDevice" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customers" ADD COLUMN "emailLookup" TEXT;

CREATE TABLE "pos_devices" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "appVersion" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pos_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pos_devices_tokenHash_key" ON "pos_devices"("tokenHash");
CREATE INDEX "pos_devices_branchId_idx" ON "pos_devices"("branchId");

CREATE TABLE "webauthn_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webauthn_credentials_credentialId_key" ON "webauthn_credentials"("credentialId");

CREATE TABLE "custom_fields" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    CONSTRAINT "custom_fields_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_fields_branchId_entity_key_key" ON "custom_fields"("branchId", "entity", "key");

CREATE TABLE "custom_field_values" (
    "id" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "custom_field_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_field_values_fieldId_entityId_key" ON "custom_field_values"("fieldId", "entityId");

CREATE TABLE "saved_reports" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "days" INTEGER NOT NULL DEFAULT 7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "saved_reports_branchId_idx" ON "saved_reports"("branchId");

CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automation_rules_branchId_idx" ON "automation_rules"("branchId");

CREATE TABLE "offline_conflicts" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "offline_conflicts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "offline_conflicts_branchId_resolvedAt_idx" ON "offline_conflicts"("branchId", "resolvedAt");

CREATE TABLE "replay_receipts" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "replay_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "replay_receipts_branchId_requestId_key" ON "replay_receipts"("branchId", "requestId");

ALTER TABLE "pos_devices" ADD CONSTRAINT "pos_devices_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "custom_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offline_conflicts" ADD CONSTRAINT "offline_conflicts_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "replay_receipts" ADD CONSTRAINT "replay_receipts_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
