-- A task can belong to more than one entity (playbook-v5 P20/4).
--
-- ── WHY A JOIN TABLE, AND WHY THE OLD COLUMNS STAY ──────────────────────────
--
-- `tasks.entity_type` / `tasks.entity_id` already carry a task's entity, and
-- roughly twenty places write them: signals, audits, referrals, quote rules,
-- workflow triggers, project templates. Those columns are the SINGLE-ENTITY
-- FAST PATH and they are not going anywhere.
--
-- This table holds the ADDITIONAL links — the deal-and-its-company case the
-- playbook asks for. Reads union the two, in one function.
--
-- ── WHY NOTHING IS MIGRATED INTO IT ─────────────────────────────────────────
--
-- The tempting alternative was to copy every existing link in here and treat
-- this table as the whole truth, with the columns kept as a mirror. That
-- would mean twenty writers maintaining a mirror, and a mirror with twenty
-- writers drifts — at which point a task appears in one panel and not the
-- other and nobody can say which is right.
--
-- So: no copy, no drift, and nothing to lose in a migration. Existing links
-- stay exactly where every writer already puts them.
CREATE TABLE "task_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    -- lead | company | deal | project | document — the same vocabulary as
    -- tasks.entity_type, deliberately, so one function resolves labels and
    -- hrefs for both.
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_links_pkey" PRIMARY KEY ("id")
);

-- One link per task per entity. The panel counts rows, so a duplicate would
-- show the same task twice.
CREATE UNIQUE INDEX "task_links_task_id_entity_type_entity_id_key"
    ON "task_links"("task_id", "entity_type", "entity_id");

-- The reverse lookup this table exists for: "every task linked to this lead".
CREATE INDEX "task_links_workspace_id_entity_type_entity_id_idx"
    ON "task_links"("workspace_id", "entity_type", "entity_id");

ALTER TABLE "task_links" ADD CONSTRAINT "task_links_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
