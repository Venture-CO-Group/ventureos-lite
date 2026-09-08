-- A saved view, emailed on a schedule (P2/2.1).
--
-- The export already takes the columns and the filter that are on screen, and
-- a saved view already IS a named filter plus columns plus a sort. So a
-- schedule needs to say almost nothing: which view, what format, how often, to
-- whom. Re-specifying the filter here would be a second place for it to drift
-- out of step with the tab people actually look at.
--
-- Deleting the view cascades: a schedule pointing at a filter nobody can see
-- any more would send a report nobody could reproduce.
-- CreateTable
CREATE TABLE "scheduled_exports" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "view_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'xlsx',
    "cadence" TEXT NOT NULL DEFAULT 'weekly',
    "day_of_week" INTEGER NOT NULL DEFAULT 1,
    "day_of_month" INTEGER NOT NULL DEFAULT 1,
    "hour" INTEGER NOT NULL DEFAULT 8,
    "recipients" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_exports_workspace_id_enabled_idx" ON "scheduled_exports"("workspace_id", "enabled");

-- CreateIndex
CREATE INDEX "scheduled_exports_enabled_next_run_at_idx" ON "scheduled_exports"("enabled", "next_run_at");

-- AddForeignKey
ALTER TABLE "scheduled_exports" ADD CONSTRAINT "scheduled_exports_view_id_fkey" FOREIGN KEY ("view_id") REFERENCES "saved_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;
