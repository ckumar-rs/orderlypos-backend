-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "printerCodepage" TEXT NOT NULL DEFAULT 'CP858',
ADD COLUMN     "printerColumns" INTEGER,
ADD COLUMN     "printerPaperWidthMm" INTEGER NOT NULL DEFAULT 80;

-- Existing installs were printing with a fixed 42-column grid on 80 mm paper.
-- Keep exactly that until an admin changes it (new branches use the 48-column
-- default for a 576-dot head; clear "Columns" in Settings to switch).
UPDATE "branches" SET "printerColumns" = 42;
