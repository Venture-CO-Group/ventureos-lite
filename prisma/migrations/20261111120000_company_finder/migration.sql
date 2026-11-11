-- CreateEnum
CREATE TYPE "FinderListStatus" AS ENUM ('DRAFT', 'HARVESTING', 'READY', 'ENRICHING', 'CHECKPOINT', 'PAUSED_QUOTA', 'CONTACTS', 'IDLE', 'FAILED');

-- CreateEnum
CREATE TYPE "FinderResultState" AS ENUM ('PENDING', 'EXCLUDED', 'MATCH', 'NO_MATCH', 'NOT_FOUND', 'ERROR');

-- AlterEnum
ALTER TYPE "LeadSource" ADD VALUE 'COMPANY_FINDER';

-- AlterEnum
ALTER TYPE "PoolSource" ADD VALUE 'COMPANY_FINDER';

-- AlterEnum
ALTER TYPE "RegistryLookupPurpose" ADD VALUE 'FINDER_RUN';

-- CreateTable
CREATE TABLE "finder_lists" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "criteria" JSONB NOT NULL,
    "criteria_hash" TEXT NOT NULL,
    "cached_only" BOOLEAN NOT NULL DEFAULT false,
    "status" "FinderListStatus" NOT NULL DEFAULT 'DRAFT',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "message" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_run_at" TIMESTAMP(3),

    CONSTRAINT "finder_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finder_results" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "tax_number" TEXT NOT NULL,
    "pool_id" TEXT,
    "name" TEXT NOT NULL,
    "state" "FinderResultState" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "detail" TEXT,
    "priority" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "criteria_hash" TEXT,
    "from_cache" BOOLEAN NOT NULL DEFAULT false,
    "in_crm" BOOLEAN NOT NULL DEFAULT false,
    "contacts" JSONB NOT NULL DEFAULT '{}',
    "site_checked" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "evaluated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finder_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finder_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "max_lookups" INTEGER NOT NULL,
    "estimate" JSONB,
    "lookups_spent" INTEGER NOT NULL DEFAULT 0,
    "paid_matches" INTEGER NOT NULL DEFAULT 0,
    "evaluated" INTEGER NOT NULL DEFAULT 0,
    "matches" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "checkpoint_at" INTEGER,
    "message" TEXT,
    "started_by_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "finder_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "finder_lists_workspace_id_idx" ON "finder_lists"("workspace_id");

-- CreateIndex
CREATE INDEX "finder_results_workspace_id_idx" ON "finder_results"("workspace_id");

-- CreateIndex
CREATE INDEX "finder_results_workspace_id_list_id_state_idx" ON "finder_results"("workspace_id", "list_id", "state");

-- CreateIndex
CREATE INDEX "finder_results_workspace_id_tax_number_idx" ON "finder_results"("workspace_id", "tax_number");

-- CreateIndex
CREATE UNIQUE INDEX "finder_results_list_id_tax_number_key" ON "finder_results"("list_id", "tax_number");

-- CreateIndex
CREATE INDEX "finder_runs_workspace_id_idx" ON "finder_runs"("workspace_id");

-- CreateIndex
CREATE INDEX "finder_runs_workspace_id_list_id_idx" ON "finder_runs"("workspace_id", "list_id");

-- AddForeignKey
ALTER TABLE "finder_results" ADD CONSTRAINT "finder_results_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "finder_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finder_runs" ADD CONSTRAINT "finder_runs_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "finder_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

