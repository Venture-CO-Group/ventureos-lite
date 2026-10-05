-- Outbound history and recovery: decision time and actor on every candidate,
-- searchable contact fields, restore and follow-up-cancel bookkeeping, retracted
-- rejections, and room for a regenerated draft beside the one it supersedes.

-- DropIndex
DROP INDEX "outreach_drafts_candidate_id_step_key";

-- AlterTable
ALTER TABLE "candidate_events" ADD COLUMN     "retracted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "outreach_drafts" ADD COLUMN     "superseded_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "prospect_candidates" ADD COLUMN     "contact_email" TEXT,
ADD COLUMN     "contact_name" TEXT,
ADD COLUMN     "followups_cancelled_at" TIMESTAMP(3),
ADD COLUMN     "restore_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "restore_note" TEXT,
ADD COLUMN     "restored_at" TIMESTAMP(3),
ADD COLUMN     "restored_by_id" TEXT,
ADD COLUMN     "state_changed_at" TIMESTAMP(3),
ADD COLUMN     "state_changed_by_id" TEXT;

-- CreateIndex
CREATE INDEX "outreach_drafts_candidate_id_step_idx" ON "outreach_drafts"("candidate_id", "step");

-- CreateIndex
CREATE INDEX "prospect_candidates_workspace_id_state_state_changed_at_idx" ON "prospect_candidates"("workspace_id", "state", "state_changed_at");



-- Backfill: the decision time and actor of the event that put each candidate
-- in its current state; the row's own update time where no event says.
UPDATE "prospect_candidates" c
SET "state_changed_at" = e."at", "state_changed_by_id" = e."user_id"
FROM (
  SELECT DISTINCT ON ("candidate_id") "candidate_id", "to_state", "at", "user_id"
  FROM "candidate_events"
  ORDER BY "candidate_id", "at" DESC
) e
WHERE e."candidate_id" = c."id" AND e."to_state" = c."state";

UPDATE "prospect_candidates" SET "state_changed_at" = "updated_at" WHERE "state_changed_at" IS NULL;

UPDATE "prospect_candidates"
SET "contact_name" = NULLIF("contact"->>'name', ''), "contact_email" = NULLIF("contact"->>'email', '')
WHERE "contact" IS NOT NULL;
