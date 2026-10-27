-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "lastSentAt" TIMESTAMP(3),
ADD COLUMN     "lastSentCount" INTEGER;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "marketingOptOut" BOOLEAN NOT NULL DEFAULT false;

