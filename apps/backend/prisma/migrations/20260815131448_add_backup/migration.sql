-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

-- CreateTable
CREATE TABLE "backups" (
    "id" TEXT NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'PENDING',
    "sizeBytes" INTEGER,
    "s3KeyDb" TEXT,
    "s3KeyUploads" TEXT,
    "sha256" TEXT,
    "triggeredById" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "endpoint" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "accessKeyId" TEXT NOT NULL,
    "secretAccessKey" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'auto',
    "intervalDays" INTEGER NOT NULL DEFAULT 3,
    "retainCount" INTEGER NOT NULL DEFAULT 2,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backup_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backups_status_createdAt_idx" ON "backups"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "backups" ADD CONSTRAINT "backups_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
