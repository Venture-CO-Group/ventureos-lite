-- Outbound motor, phase F2 (playbook-v6, spec §4.43.4): the registry
-- datasheet cache, the search cache, the detail-quota ledger and the
-- workspace outbound config.

-- CreateEnum
CREATE TYPE "RegistryLookupPurpose" AS ENUM ('NIGHTLY_RUN', 'MANUAL_RUN', 'INTERACTIVE', 'REFERENCE_SEED', 'MANUAL_REFRESH');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "outbound_config" JSONB;

-- CreateTable
CREATE TABLE "registry_sheets" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tax_number" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sheet" JSONB NOT NULL,
    "not_found" BOOLEAN NOT NULL DEFAULT false,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registry_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registry_search_cache" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "query_key" TEXT NOT NULL,
    "results" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registry_search_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registry_quota_ledger" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "tax_number" TEXT NOT NULL,
    "purpose" "RegistryLookupPurpose" NOT NULL,
    "candidate_id" TEXT,
    "cache_hit" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT NOT NULL,
    "user_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registry_quota_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "registry_sheets_workspace_id_idx" ON "registry_sheets"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "registry_sheets_workspace_id_tax_number_key" ON "registry_sheets"("workspace_id", "tax_number");

-- CreateIndex
CREATE INDEX "registry_search_cache_workspace_id_idx" ON "registry_search_cache"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "registry_search_cache_workspace_id_query_key_key" ON "registry_search_cache"("workspace_id", "query_key");

-- CreateIndex
CREATE INDEX "registry_quota_ledger_workspace_id_month_idx" ON "registry_quota_ledger"("workspace_id", "month");

