CREATE TABLE "whatsapp_catalog_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'META',
    "providerEventId" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "restaurantId" TEXT,
    "branchId" TEXT,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processingStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "whatsapp_catalog_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_catalog_events_provider_providerEventId_key" ON "whatsapp_catalog_events"("provider", "providerEventId");
CREATE INDEX "whatsapp_catalog_events_processingStatus_receivedAt_idx" ON "whatsapp_catalog_events"("processingStatus", "receivedAt");

CREATE TABLE "whatsapp_catalog_submissions" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "customerId" TEXT,
    "catalogId" TEXT,
    "submittedCart" JSONB NOT NULL,
    "validatedCart" JSONB,
    "orderId" TEXT,
    "submissionStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_catalog_submissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_catalog_submissions_branchId_messageId_key" ON "whatsapp_catalog_submissions"("branchId", "messageId");
CREATE INDEX "whatsapp_catalog_submissions_branchId_createdAt_idx" ON "whatsapp_catalog_submissions"("branchId", "createdAt");

ALTER TABLE "whatsapp_catalog_submissions" ADD CONSTRAINT "whatsapp_catalog_submissions_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_catalog_submissions" ADD CONSTRAINT "whatsapp_catalog_submissions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
