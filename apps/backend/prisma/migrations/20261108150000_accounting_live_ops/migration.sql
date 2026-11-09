-- AlterTable
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "vendor" TEXT;

-- AlterTable: new expenses await approval unless Settings turns that off.
ALTER TABLE "expenses" ALTER COLUMN "status" SET DEFAULT 'PENDING';
