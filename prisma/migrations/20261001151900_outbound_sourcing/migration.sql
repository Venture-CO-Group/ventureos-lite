-- Outbound motor, phase F3 (playbook-v6, spec §4.43.3-6): the candidate pool,
-- harvest progress, sourcing runs, candidates and their state-change trail.

-- CreateEnum
CREATE TYPE "PoolSource" AS ENUM ('NAME_HARVEST', 'SEED_LIST', 'PLACES', 'CSV');

-- CreateEnum
CREATE TYPE "CandidateState" AS ENUM ('SOURCED', 'ENRICHED', 'FILTERED_IN', 'FILTERED_OUT', 'AUDITED', 'CONTACT_RESOLVED', 'NO_CONTACT', 'DRAFTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SENT', 'REPLIED', 'LINKEDIN_QUEUE');

-- CreateEnum
CREATE TYPE "CandidateReason" AS ENUM ('IN_CRM', 'SUPPRESSED', 'RECENTLY_FILTERED', 'NOT_IN_REGISTRY', 'NO_TAX_NUMBER', 'STATUS', 'SEGMENT', 'SIZE', 'REVENUE', 'REGION', 'LEGAL_FORM', 'FOUNDED', 'NO_WEBSITE', 'EXISTING_CLIENT', 'AUDIT_SCORE', 'SIGNALS', 'NO_NAMED_CONTACT', 'NO_HOOK', 'WRONG_TARGETING', 'WEAK_COPY', 'WRONG_CONTACT', 'BAD_TIMING', 'ALREADY_IN_CONTACT', 'OTHER');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'AWAITING_AUDITS', 'PAUSED_QUOTA', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('NIGHTLY', 'MANUAL');

-- CreateTable
CREATE TABLE "candidate_pool" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "tax_number" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "domain" TEXT,
    "website" TEXT,
    "phone" TEXT,
    "city" TEXT,
    "google_place_id" TEXT,
    "source" "PoolSource" NOT NULL,
    "segment_keys" JSONB NOT NULL DEFAULT '[]',
    "hits" JSONB NOT NULL DEFAULT '[]',
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "harvest_progress" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "segment_key" TEXT NOT NULL,
    "fragment" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "next_page" INTEGER NOT NULL DEFAULT 1,
    "total_pages" INTEGER,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "found" INTEGER NOT NULL DEFAULT 0,
    "harvested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "harvest_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sourcing_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "product_id" TEXT,
    "profile_id" TEXT,
    "trigger" "RunTrigger" NOT NULL DEFAULT 'MANUAL',
    "channel" TEXT NOT NULL DEFAULT 'all',
    "requested" INTEGER NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "estimate" JSONB,
    "counters" JSONB NOT NULL DEFAULT '{}',
    "quota_used" INTEGER NOT NULL DEFAULT 0,
    "passes" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "started_by_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "run_date" TEXT,

    CONSTRAINT "sourcing_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_candidates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "product_id" TEXT,
    "profile_id" TEXT,
    "tax_number" TEXT,
    "name" TEXT NOT NULL,
    "state" "CandidateState" NOT NULL DEFAULT 'SOURCED',
    "reason" "CandidateReason",
    "reason_detail" TEXT,
    "priority" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "size_band" TEXT,
    "unknown_size" BOOLEAN NOT NULL DEFAULT false,
    "matched_segment" TEXT,
    "website" TEXT,
    "audit_id" TEXT,
    "facts" JSONB NOT NULL DEFAULT '[]',
    "contact" JSONB,
    "company_id" TEXT,
    "lead_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "parked_until" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "from_state" "CandidateState",
    "to_state" "CandidateState" NOT NULL,
    "reason" "CandidateReason",
    "detail" TEXT,
    "user_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "candidate_pool_workspace_id_idx" ON "candidate_pool"("workspace_id");

-- CreateIndex
CREATE INDEX "candidate_pool_workspace_id_tax_number_idx" ON "candidate_pool"("workspace_id", "tax_number");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_pool_workspace_id_dedupe_key_key" ON "candidate_pool"("workspace_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "harvest_progress_workspace_id_idx" ON "harvest_progress"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "harvest_progress_workspace_id_segment_key_fragment_key" ON "harvest_progress"("workspace_id", "segment_key", "fragment");

-- CreateIndex
CREATE INDEX "sourcing_runs_workspace_id_idx" ON "sourcing_runs"("workspace_id");

-- CreateIndex
CREATE INDEX "sourcing_runs_workspace_id_status_idx" ON "sourcing_runs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "prospect_candidates_workspace_id_idx" ON "prospect_candidates"("workspace_id");

-- CreateIndex
CREATE INDEX "prospect_candidates_workspace_id_state_idx" ON "prospect_candidates"("workspace_id", "state");

-- CreateIndex
CREATE INDEX "prospect_candidates_workspace_id_profile_id_state_idx" ON "prospect_candidates"("workspace_id", "profile_id", "state");

-- CreateIndex
CREATE INDEX "prospect_candidates_pool_id_idx" ON "prospect_candidates"("pool_id");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_candidates_run_id_pool_id_key" ON "prospect_candidates"("run_id", "pool_id");

-- CreateIndex
CREATE INDEX "candidate_events_workspace_id_idx" ON "candidate_events"("workspace_id");

-- CreateIndex
CREATE INDEX "candidate_events_candidate_id_idx" ON "candidate_events"("candidate_id");

-- AddForeignKey
ALTER TABLE "prospect_candidates" ADD CONSTRAINT "prospect_candidates_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sourcing_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_candidates" ADD CONSTRAINT "prospect_candidates_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "candidate_pool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_events" ADD CONSTRAINT "candidate_events_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "prospect_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
