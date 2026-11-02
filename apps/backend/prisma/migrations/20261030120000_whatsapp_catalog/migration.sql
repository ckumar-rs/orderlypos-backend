CREATE TABLE "whatsapp_catalog_connections" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'META',
    "kapsoCustomerId" TEXT,
    "phoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "businessPhone" TEXT,
    "catalogId" TEXT NOT NULL,
    "connectionStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "accessTokenSealed" TEXT,
    "verifyTokenHash" TEXT,
    "lastWebhookAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_catalog_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_catalog_connections_branchId_key" ON "whatsapp_catalog_connections"("branchId");
CREATE UNIQUE INDEX "whatsapp_catalog_connections_phoneNumberId_key" ON "whatsapp_catalog_connections"("phoneNumberId");
CREATE UNIQUE INDEX "whatsapp_catalog_connections_verifyTokenHash_key" ON "whatsapp_catalog_connections"("verifyTokenHash");
CREATE INDEX "whatsapp_catalog_connections_restaurantId_idx" ON "whatsapp_catalog_connections"("restaurantId");

CREATE TABLE "whatsapp_catalog_products" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "retailerId" TEXT NOT NULL,
    "payloadHash" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_catalog_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_catalog_products_menuItemId_key" ON "whatsapp_catalog_products"("menuItemId");
CREATE UNIQUE INDEX "whatsapp_catalog_products_connectionId_retailerId_key" ON "whatsapp_catalog_products"("connectionId", "retailerId");
CREATE INDEX "whatsapp_catalog_products_syncStatus_nextAttemptAt_idx" ON "whatsapp_catalog_products"("syncStatus", "nextAttemptAt");

ALTER TABLE "whatsapp_catalog_connections" ADD CONSTRAINT "whatsapp_catalog_connections_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_catalog_connections" ADD CONSTRAINT "whatsapp_catalog_connections_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_catalog_products" ADD CONSTRAINT "whatsapp_catalog_products_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "whatsapp_catalog_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_catalog_products" ADD CONSTRAINT "whatsapp_catalog_products_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
