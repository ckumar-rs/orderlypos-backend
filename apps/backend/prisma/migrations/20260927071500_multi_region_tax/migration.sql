-- CreateEnum
CREATE TYPE "TaxRegime" AS ENUM ('INDIA_GST', 'US_SALES_TAX', 'EU_VAT', 'ES_IVA', 'CUSTOM');

-- CreateEnum
CREATE TYPE "TaxMode" AS ENUM ('INCLUSIVE', 'EXCLUSIVE');

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'IN',
ADD COLUMN     "taxRegime" "TaxRegime" NOT NULL DEFAULT 'INDIA_GST',
ADD COLUMN     "taxMode" "TaxMode" NOT NULL DEFAULT 'INCLUSIVE',
ADD COLUMN     "taxLabel" TEXT,
ADD COLUMN     "taxId" TEXT;
