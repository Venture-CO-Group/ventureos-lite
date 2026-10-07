-- A workspace can be deleted: hidden at once, purged after a grace period.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deleted_by" TEXT,
ADD COLUMN     "purge_after" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "workspaces_deleted_at_idx" ON "workspaces"("deleted_at");
