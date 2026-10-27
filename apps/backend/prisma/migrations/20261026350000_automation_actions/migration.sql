ALTER TYPE "OutboundPurpose" ADD VALUE IF NOT EXISTS 'AUTOMATION';

ALTER TABLE "automation_rules" ADD COLUMN "actions" JSONB NOT NULL DEFAULT '["NOTIFY"]';
ALTER TABLE "automation_rules" ADD COLUMN "emailTo" TEXT;
ALTER TABLE "automation_rules" ADD COLUMN "phoneTo" TEXT;
ALTER TABLE "automation_rules" ADD COLUMN "webhookUrl" TEXT;
ALTER TABLE "automation_rules" ADD COLUMN "taskTitle" TEXT;
ALTER TABLE "automation_rules" ADD COLUMN "nextRuleId" TEXT;
ALTER TABLE "automation_rules" ADD COLUMN "lastError" TEXT;

CREATE TABLE "automation_tasks" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "automation_tasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "automation_tasks_branchId_doneAt_idx" ON "automation_tasks"("branchId", "doneAt");
ALTER TABLE "automation_tasks" ADD CONSTRAINT "automation_tasks_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_tasks" ADD CONSTRAINT "automation_tasks_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
