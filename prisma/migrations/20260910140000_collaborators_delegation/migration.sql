-- Collaborators and delegation (playbook-v5 P20/6).
--
-- ── WHY assignee_id STAYS A SINGLE COLUMN ───────────────────────────────────
--
-- The obvious move is to turn the assignee into an array, and it is the wrong
-- one. "Everyone is responsible" is how tasks die: with three names on a card
-- nobody is the person who has to answer for it, and the board loses the one
-- fact it exists to carry. So there is exactly one accountable owner, and the
-- people helping are a separate relationship.
--
-- ── THREE RELATIONSHIPS, NOT ONE LIST ───────────────────────────────────────
--
--   assignee     — one person, accountable, on the card.
--   collaborator — working on it. Shows in their My Work behind a toggle.
--   follower     — watching it. Hears about comments, owes nothing.
--
-- Followers already existed and already mean the third thing, so this adds
-- only the middle one.
CREATE TABLE "task_collaborators" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "added_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_collaborators_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_collaborators_task_id_user_id_key"
    ON "task_collaborators"("task_id", "user_id");

-- "Everything I am collaborating on", which is the My Work toggle.
CREATE INDEX "task_collaborators_workspace_id_user_id_idx"
    ON "task_collaborators"("workspace_id", "user_id");

ALTER TABLE "task_collaborators" ADD CONSTRAINT "task_collaborators_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── THE DELEGATION TRAIL ────────────────────────────────────────────────────
--
-- Who handed this over, and when. Two columns on the task rather than a
-- lookup through the event log, because the card and the detail panel want to
-- say "delegated by Anna" without reading a history for every row.
--
-- The full trail is in task_events; this is the current state of it.
ALTER TABLE "tasks" ADD COLUMN "delegated_by" TEXT;
ALTER TABLE "tasks" ADD COLUMN "delegated_at" TIMESTAMP(3);

-- ── AND THE TRAIL ITSELF ────────────────────────────────────────────────────
--
-- Deliberately the same shape as membership_events: who it happened to, who
-- did it, what it was before and after. A reassignment somebody disputes is
-- answered by a row, not by a recollection.
CREATE TABLE "task_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    -- One of TASK_EVENT_KINDS in src/modules/tasks/events.ts.
    "kind" TEXT NOT NULL,
    -- The person it happened TO, where there is one: the new assignee, the
    -- collaborator added.
    "user_id" TEXT,
    -- The person who did it. Null for the system — a workflow rule.
    "actor_user_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "task_events_workspace_id_task_id_at_idx"
    ON "task_events"("workspace_id", "task_id", "at");

ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
