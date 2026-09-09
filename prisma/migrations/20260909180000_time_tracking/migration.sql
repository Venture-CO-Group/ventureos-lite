-- Estimates and time tracking (playbook-v5 P20/1).
--
-- ── MINUTES AS AN INTEGER, NOT HOURS AS A FLOAT ─────────────────────────────
--
-- The playbook asks for "an estimate in hours, decimal". Stored as whole
-- MINUTES for the same reason money is stored as integer forints (CLAUDE.md):
-- 1.5 hours is exactly 90 minutes, whereas a float of 0.1 hours is not exactly
-- six of anything, and a sum of forty of them is wrong by an amount nobody can
-- explain. The UI reads and writes hours; the column holds minutes.
ALTER TABLE "tasks" ADD COLUMN "estimate_minutes" INTEGER;

-- Milestones carry estimates too, so a project can be costed before it starts.
ALTER TABLE "milestones" ADD COLUMN "estimate_minutes" INTEGER;

-- One row per stretch of work. A RUNNING timer is a row with no `ended_at`,
-- which is what makes it survive a reload and a different machine: the timer
-- is not browser state, it is a fact in the database.
CREATE TABLE "time_entries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    -- Set when the entry is closed, or written directly for a manual entry.
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- The three reads: a task's entries, a person's week, and the one running
-- timer a person is allowed.
CREATE INDEX "time_entries_workspace_id_task_id_idx" ON "time_entries"("workspace_id", "task_id");
CREATE INDEX "time_entries_workspace_id_user_id_started_at_idx"
    ON "time_entries"("workspace_id", "user_id", "started_at");

-- ONE RUNNING TIMER PER PERSON, enforced by the database rather than by
-- remembering to check. A partial unique index is the only way to say "at most
-- one row where ended_at is null" without a trigger.
CREATE UNIQUE INDEX "time_entries_one_running_per_user"
    ON "time_entries"("user_id") WHERE "ended_at" IS NULL;

ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
