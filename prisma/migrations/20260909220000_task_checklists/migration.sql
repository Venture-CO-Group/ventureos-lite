-- Lightweight checklists on a task (playbook-v5 P20/3).
--
-- ── WHY A TABLE AND NOT A JSON ARRAY ON THE TASK ────────────────────────────
--
-- A JSON array would have been fewer lines. But an item can be PROMOTED to a
-- real subtask, which means it needs a stable id to move, and the list is
-- ordered and reorderable, which means sparse positions like every other
-- ordered thing here. Both are awkward inside a blob and ordinary as rows.
--
-- ── AND WHY IT IS DELIBERATELY THINNER THAN A SUBTASK ───────────────────────
--
-- No assignee, no due date, no comments, no dependencies. A checklist is the
-- steps INSIDE one person's task; a subtask is work somebody else may own. If
-- this table grew an assignee it would become a worse copy of Task.
CREATE TABLE "task_checklist_items" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "done_at" TIMESTAMP(3),
    -- Sparse, in steps of 1024, so a reorder is one write.
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_checklist_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "task_checklist_items_workspace_id_task_id_position_idx"
    ON "task_checklist_items"("workspace_id", "task_id", "position");

ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
