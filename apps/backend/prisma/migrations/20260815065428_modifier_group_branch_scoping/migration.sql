/*
  Warnings:

  - Added the required column `branchId` to the `modifier_groups` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "modifier_groups" ADD COLUMN     "branchId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "modifier_groups_branchId_idx" ON "modifier_groups"("branchId");

-- AddForeignKey
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
