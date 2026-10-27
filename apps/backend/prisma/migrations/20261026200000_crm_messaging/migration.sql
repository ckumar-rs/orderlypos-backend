-- WhatsApp Cloud API, SMS gateway, RFM/CLV, outbound log (all stored, no hardcoded hosts)
ALTER TABLE "restaurants" ADD COLUMN "waCloudEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "waCloudBaseUrl" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "waCloudPhoneNumberId" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "waCloudAccessTokenSealed" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "waCloudTemplateName" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "waCloudTemplateLang" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "smsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "smsProvider" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "smsBaseUrl" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "smsApiKeySealed" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "smsApiSecretSealed" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "smsSenderId" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "smsCountryPrefix" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "clvHorizonMonths" INTEGER NOT NULL DEFAULT 12;
ALTER TABLE "restaurants" ADD COLUMN "clvMarginPercent" DECIMAL(5,2) NOT NULL DEFAULT 100;

ALTER TABLE "customers" ADD COLUMN "rfmRecency" INTEGER;
ALTER TABLE "customers" ADD COLUMN "rfmFrequency" INTEGER;
ALTER TABLE "customers" ADD COLUMN "rfmMonetary" INTEGER;
ALTER TABLE "customers" ADD COLUMN "rfmScore" TEXT;
ALTER TABLE "customers" ADD COLUMN "rfmSegment" TEXT;
ALTER TABLE "customers" ADD COLUMN "clvEstimate" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "customers" ADD COLUMN "rfmComputedAt" TIMESTAMP(3);

ALTER TABLE "campaigns" ADD COLUMN "rfmLabel" TEXT;

ALTER TYPE "CampaignSegment" ADD VALUE IF NOT EXISTS 'RFM';

CREATE TABLE "rfm_labels" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "minR" INTEGER NOT NULL DEFAULT 1,
  "maxR" INTEGER NOT NULL DEFAULT 5,
  "minF" INTEGER NOT NULL DEFAULT 1,
  "maxF" INTEGER NOT NULL DEFAULT 5,
  "minM" INTEGER NOT NULL DEFAULT 1,
  "maxM" INTEGER NOT NULL DEFAULT 5,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "rfm_labels_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "rfm_labels_restaurantId_idx" ON "rfm_labels"("restaurantId");
ALTER TABLE "rfm_labels" ADD CONSTRAINT "rfm_labels_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "OutboundChannel" AS ENUM ('WHATSAPP', 'SMS');
CREATE TYPE "OutboundPurpose" AS ENUM ('RECEIPT', 'RESERVATION', 'CAMPAIGN', 'TEST');
CREATE TYPE "OutboundStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

CREATE TABLE "outbound_messages" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "branchId" TEXT,
  "channel" "OutboundChannel" NOT NULL,
  "purpose" "OutboundPurpose" NOT NULL,
  "to" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "provider" TEXT,
  "status" "OutboundStatus" NOT NULL DEFAULT 'QUEUED',
  "error" TEXT,
  "providerRef" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  CONSTRAINT "outbound_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "outbound_messages_restaurantId_status_nextAttemptAt_idx"
  ON "outbound_messages"("restaurantId", "status", "nextAttemptAt");
CREATE INDEX "outbound_messages_branchId_idx" ON "outbound_messages"("branchId");
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
