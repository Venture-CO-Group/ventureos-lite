-- "These two are not the same thing." (P2/2.3)
--
-- The duplicate scanner offers pairs on three signals, and the weakest — a
-- fuzzy name match — is suggestive rather than certain: "Alfa Bt" and "Alfa
-- Kft" quite possibly are two different companies. There was no way to say so.
-- A legitimate false positive sat in the review list for ever, and after a few
-- of those the whole panel gets ignored, which costs more than the duplicates
-- it was built to catch.
--
-- The pair is stored SORTED so (a,b) and (b,a) are one row and cannot both be
-- dismissed independently.
-- CreateTable
CREATE TABLE "duplicate_dismissals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "a_id" TEXT NOT NULL,
    "b_id" TEXT NOT NULL,
    "dismissed_by" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "duplicate_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "duplicate_dismissals_workspace_id_entity_idx" ON "duplicate_dismissals"("workspace_id", "entity");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_dismissals_workspace_id_entity_a_id_b_id_key" ON "duplicate_dismissals"("workspace_id", "entity", "a_id", "b_id");
