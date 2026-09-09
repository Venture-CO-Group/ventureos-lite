-- Archiving a matched email thread (playbook-v5 P17/1).
--
-- The inbox's bulk actions are "mark read, link to lead, archive". The first
-- two had columns; archiving had nowhere to go, and the alternative — deleting
-- the thread — would throw away correspondence that matched a real lead.
--
-- Nullable timestamp rather than a boolean, so the list can say WHEN something
-- was put away, and so un-archiving is setting it back to NULL.
ALTER TABLE "email_threads" ADD COLUMN "archived_at" TIMESTAMP(3);
CREATE INDEX "email_threads_workspace_id_archived_at_idx" ON "email_threads"("workspace_id", "archived_at");
