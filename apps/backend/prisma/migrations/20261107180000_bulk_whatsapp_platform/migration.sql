-- Link OrderlyPOS to a standalone bulk WhatsApp platform (campaigns).
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "bulkWaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "bulkWaBaseUrl" TEXT;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "bulkWaApiKeySealed" TEXT;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "bulkWaWebhookSecretSealed" TEXT;

ALTER TYPE "OutboundStatus" ADD VALUE IF NOT EXISTS 'READ';

ALTER TABLE "outbound_messages" ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMP(3);
