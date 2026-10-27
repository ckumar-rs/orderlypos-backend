ALTER TABLE "floors" ADD COLUMN "gridSize" DOUBLE PRECISION NOT NULL DEFAULT 20;

ALTER TABLE "kitchen_stations" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'COOK';

CREATE TABLE "kitchen_courses" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "holdByDefault" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "kitchen_courses_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "kitchen_courses_branchId_idx" ON "kitchen_courses"("branchId");
ALTER TABLE "kitchen_courses" ADD CONSTRAINT "kitchen_courses_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "menu_items" ADD COLUMN "courseId" TEXT;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "kitchen_courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TYPE "KotItemStatus" ADD VALUE IF NOT EXISTS 'DELAYED';

ALTER TABLE "kots" ADD COLUMN "courseId" TEXT;
ALTER TABLE "kots" ADD COLUMN "held" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "kots" ADD COLUMN "firedAt" TIMESTAMP(3);
ALTER TABLE "kots" ADD COLUMN "expoAssembledAt" TIMESTAMP(3);
ALTER TABLE "kots" ADD CONSTRAINT "kots_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "kitchen_courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "kot_items" ADD COLUMN "delayReason" TEXT;
