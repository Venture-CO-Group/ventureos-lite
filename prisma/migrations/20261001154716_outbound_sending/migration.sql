-- Outbound motor, phase F5 (playbook-v6, spec §4.43.9): the sending trail on a draft —
-- from-address, unsubscribe capability, bounce.

-- AlterTable
ALTER TABLE "outreach_drafts" ADD COLUMN     "bounced_at" TIMESTAMP(3),
ADD COLUMN     "sent_from" TEXT,
ADD COLUMN     "unsubscribe_token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "outreach_drafts_unsubscribe_token_key" ON "outreach_drafts"("unsubscribe_token");
