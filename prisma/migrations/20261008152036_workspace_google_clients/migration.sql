-- Per-workspace Google OAuth clients, and which client issued each Google credential.

-- AlterTable
ALTER TABLE "google_credentials" ADD COLUMN     "client_ref" TEXT,
ADD COLUMN     "invalidated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "workspace_google_clients" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_enc" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'untested',
    "last_tested_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_google_clients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_google_clients_workspace_id_key" ON "workspace_google_clients"("workspace_id");

-- CreateIndex
CREATE INDEX "google_credentials_client_ref_idx" ON "google_credentials"("client_ref");


-- Every credential that exists today was issued by the installation's own
-- (env) client — there was no other. Recorded explicitly so a refresh never
-- has to guess.
UPDATE "google_credentials" SET "client_ref" = 'env' WHERE "client_ref" IS NULL;
