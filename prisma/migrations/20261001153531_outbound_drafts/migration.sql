-- Outbound motor, phase F4 (playbook-v6, spec §4.43.7-8): generated drafts and their
-- review trail, and the OUTBOUND_ENGINE lead source.

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "LeadSource" ADD VALUE 'OUTBOUND_ENGINE';

-- CreateTable
CREATE TABLE "outreach_drafts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "product_id" TEXT,
    "step" INTEGER NOT NULL DEFAULT 0,
    "variant" TEXT NOT NULL,
    "language" "Lang" NOT NULL DEFAULT 'HU',
    "template_version" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "to_name" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "original_subject" TEXT NOT NULL,
    "original_body" TEXT NOT NULL,
    "personalisation_points" JSONB NOT NULL DEFAULT '[]',
    "status" "DraftStatus" NOT NULL DEFAULT 'PENDING',
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "opened_at" TIMESTAMP(3),
    "opened_by_id" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "reject_reason" "CandidateReason",
    "reject_note" TEXT,
    "scheduled_for" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "gmail_message_id" TEXT,
    "gmail_thread_id" TEXT,
    "send_error" TEXT,
    "claude_cost_usd" DECIMAL(65,30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outreach_drafts_workspace_id_idx" ON "outreach_drafts"("workspace_id");

-- CreateIndex
CREATE INDEX "outreach_drafts_workspace_id_status_idx" ON "outreach_drafts"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_drafts_candidate_id_step_key" ON "outreach_drafts"("candidate_id", "step");

