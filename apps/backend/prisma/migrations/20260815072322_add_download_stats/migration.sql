-- CreateTable
CREATE TABLE "download_stats" (
    "channel" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "download_stats_pkey" PRIMARY KEY ("channel")
);
