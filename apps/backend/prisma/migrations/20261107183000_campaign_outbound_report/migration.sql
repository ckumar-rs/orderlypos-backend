-- Link outbound messages to marketing campaigns for delivery reports.
ALTER TABLE "outbound_messages" ADD COLUMN IF NOT EXISTS "campaignId" TEXT;
ALTER TABLE "outbound_messages" ADD COLUMN IF NOT EXISTS "campaignBatchId" TEXT;

CREATE INDEX IF NOT EXISTS "outbound_messages_campaignId_campaignBatchId_idx"
  ON "outbound_messages"("campaignId", "campaignBatchId");
CREATE INDEX IF NOT EXISTS "outbound_messages_campaignId_status_idx"
  ON "outbound_messages"("campaignId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'outbound_messages_campaignId_fkey'
  ) THEN
    ALTER TABLE "outbound_messages"
      ADD CONSTRAINT "outbound_messages_campaignId_fkey"
      FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
