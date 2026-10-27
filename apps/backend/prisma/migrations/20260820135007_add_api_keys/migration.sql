-- CreateTable
CREATE TABLE "staff_api_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastFour" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_api_keys" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastFour" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_api_keys_tokenHash_key" ON "staff_api_keys"("tokenHash");

-- CreateIndex
CREATE INDEX "staff_api_keys_userId_idx" ON "staff_api_keys"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "integration_api_keys_tokenHash_key" ON "integration_api_keys"("tokenHash");

-- CreateIndex
CREATE INDEX "integration_api_keys_restaurantId_idx" ON "integration_api_keys"("restaurantId");

-- CreateIndex
CREATE INDEX "integration_api_keys_branchId_idx" ON "integration_api_keys"("branchId");

-- AddForeignKey
ALTER TABLE "staff_api_keys" ADD CONSTRAINT "staff_api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_api_keys" ADD CONSTRAINT "integration_api_keys_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_api_keys" ADD CONSTRAINT "integration_api_keys_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_api_keys" ADD CONSTRAINT "integration_api_keys_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
