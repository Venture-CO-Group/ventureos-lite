-- Task boards, sections, comments and followers (P8/1).
--
-- Tasks already existed: a flat, workspace-wide list with a title, a due date,
-- an assignee and an optional link to a lead. That is enough to remember a
-- callback and not enough to run a piece of work — there was no way to group
-- tasks, order them, break one into steps, or say anything about one beyond
-- its title.
--
-- WHY "BOARD" AND NOT "PROJECT". `Project` in this schema already means a
-- post-sale delivery engagement, the thing that carries a signed contract to
-- its completion certificate. Two meanings for one word in one product is how a
-- team ends up arguing about which "project" somebody meant.
--
-- Every new column on `tasks` is nullable or defaulted, so the tasks that exist
-- — follow-ups raised from leads, calls suggested by the signal engine — keep
-- working with no board at all. A loose task is a first-class task, not a
-- migration leftover.

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "board_id" TEXT,
ADD COLUMN     "completed_by" TEXT,
ADD COLUMN     "parent_id" TEXT,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "section_id" TEXT,
ADD COLUMN     "start_at" TIMESTAMP(3),
ADD COLUMN     "tags" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "task_boards" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_sections" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_comments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mentions" JSONB NOT NULL DEFAULT '[]',
    "edited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_followers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_followers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_boards_workspace_id_archived_at_position_idx" ON "task_boards"("workspace_id", "archived_at", "position");

-- CreateIndex
CREATE INDEX "task_sections_workspace_id_board_id_position_idx" ON "task_sections"("workspace_id", "board_id", "position");

-- CreateIndex
CREATE INDEX "task_comments_workspace_id_task_id_created_at_idx" ON "task_comments"("workspace_id", "task_id", "created_at");

-- CreateIndex
CREATE INDEX "task_followers_workspace_id_user_id_idx" ON "task_followers"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_followers_task_id_user_id_key" ON "task_followers"("task_id", "user_id");

-- CreateIndex
CREATE INDEX "tasks_workspace_id_board_id_section_id_position_idx" ON "tasks"("workspace_id", "board_id", "section_id", "position");

-- CreateIndex
CREATE INDEX "tasks_workspace_id_parent_id_idx" ON "tasks"("workspace_id", "parent_id");

-- AddForeignKey
ALTER TABLE "task_sections" ADD CONSTRAINT "task_sections_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "task_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "task_boards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "task_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_followers" ADD CONSTRAINT "task_followers_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
