-- Recents and favourites, per person per workspace (playbook-v5 P17/2).
--
-- ── WHY ONE TABLE FOR BOTH ──────────────────────────────────────────────────
--
-- A recent and a favourite are the same fact — "this person cares about this
-- entity" — differing only in whether the caring was deliberate. Two tables
-- would mean two writers, two sweeps and two joins in the command palette,
-- which reads both on every keystroke.
--
-- ── WHY THE LABEL AND HREF ARE STORED ───────────────────────────────────────
--
-- The palette shows recents on an empty query, which is the moment it must be
-- instant. Resolving seven ids across leads, companies, deals, tasks, boards,
-- documents and audits would be seven queries; storing what to show makes it
-- one. The cost is a label that can go stale after a rename, which is the
-- right trade for a list of shortcuts — and opening the thing corrects it.
CREATE TABLE "user_pins" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pins_pkey" PRIMARY KEY ("id")
);

-- One row per person per entity per kind: opening a lead twice updates the
-- timestamp rather than growing the history.
CREATE UNIQUE INDEX "user_pins_user_id_workspace_id_kind_entity_type_entity_id_key"
    ON "user_pins"("user_id", "workspace_id", "kind", "entity_type", "entity_id");

-- The two reads: the palette's recents (newest first) and the sidebar's
-- favourites (hand-ordered).
CREATE INDEX "user_pins_user_id_workspace_id_kind_at_idx"
    ON "user_pins"("user_id", "workspace_id", "kind", "at" DESC);
CREATE INDEX "user_pins_workspace_id_user_id_idx" ON "user_pins"("workspace_id", "user_id");
