-- AlterTable
ALTER TABLE "users" ADD COLUMN     "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twoFactorLastStep" INTEGER,
ADD COLUMN     "twoFactorRecoveryHashes" TEXT[] DEFAULT ARRAY[]::TEXT[];

