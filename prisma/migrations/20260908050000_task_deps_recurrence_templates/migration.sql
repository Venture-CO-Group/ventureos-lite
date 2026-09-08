-- Dependencies, recurrence, templates and attachments on tasks (P3/3.1-3.5).
--
-- FOUR THINGS, ONE MIGRATION, because they all touch the same table and
-- shipping four migrations that each add a column to `tasks` buys nothing.
--
-- DEPENDENCIES get an explicit join table rather than an implicit
-- many-to-many: a self-referencing relation needs one anyway, and an explicit
-- table carries `workspace_id`, which means the tenant guard scopes it like
-- every other business row instead of relying on both endpoints being ours.
-- A dependency is REPORTED, never enforced — see the schema comment.
--
-- RECURRENCE is a JSON blob in the same shape a scheduled export uses, so "the
-- first Monday of every month" is computed by one tested function rather than
-- two. A recurring task spawns its successor when COMPLETED rather than being
-- generated on a timer: a board that fills with future copies of one task is a
-- board nobody can read.
--
-- TEMPLATES are a flag on `task_boards`, because a template IS a board. A
-- parallel model would duplicate sections, tasks, priorities and notes and then
-- drift from them. `due_offset_days` is what a template carries in place of a
-- date, since "three days after we start" is the only thing a template can
-- honestly say.
-- AlterTable
ALTER TABLE "task_boards" ADD COLUMN "is_template" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "due_offset_days" INTEGER,
ADD COLUMN     "recurred_from_id" TEXT,
ADD COLUMN     "recurrence" JSONB;

-- CreateTable
CREATE TABLE "task_dependencies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "blocked_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_attachments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_dependencies_workspace_id_blocked_by_id_idx" ON "task_dependencies"("workspace_id", "blocked_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_dependencies_task_id_blocked_by_id_key" ON "task_dependencies"("task_id", "blocked_by_id");

-- CreateIndex
CREATE INDEX "task_attachments_workspace_id_task_id_idx" ON "task_attachments"("workspace_id", "task_id");

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_blocked_by_id_fkey" FOREIGN KEY ("blocked_by_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
