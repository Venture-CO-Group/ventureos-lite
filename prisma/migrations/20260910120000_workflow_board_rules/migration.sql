-- Board automations (playbook-v5 P20/5).
--
-- ── ONE COLUMN, NOT A SECOND ENGINE ─────────────────────────────────────────
--
-- The rule table, the run log, the kill switch, the rule cap and the cycle
-- protection already exist and already work. Extending tasks into them needs
-- exactly one new fact: WHICH BOARD a rule watches.
--
-- Null means the whole workspace, which is what every existing rule is, so
-- nothing has to be backfilled and no existing rule changes behaviour.
ALTER TABLE "workflow_rules" ADD COLUMN "board_id" TEXT;

-- The engine loads rules by trigger; a board rule narrows that further, and
-- a workspace with rules on six boards should not read all six to fire one.
CREATE INDEX "workflow_rules_workspace_id_board_id_idx"
    ON "workflow_rules"("workspace_id", "board_id");
