-- Cold outbound's sending address becomes per-workspace configuration
-- (outboundConfig.sending.senderAddress) instead of a constant in code.
--
-- The Venture workspace keeps exactly the identity it had: it is the
-- installation's first workspace (created by the seed), and it gets Fanni's
-- own mailbox — the address she actually sends from (owner decision,
-- 2026-10-09; the .agency address in the old constant was a mistake). Every other workspace starts with none,
-- and sends nothing until an Owner configures its own.
UPDATE "workspaces"
SET "outbound_config" = jsonb_set(
  COALESCE("outbound_config", '{}'::jsonb),
  '{sending}',
  COALESCE("outbound_config"->'sending', '{}'::jsonb)
    || '{"senderAddress": "fanni.viragh@ventureco.group"}'::jsonb
)
WHERE "id" = (SELECT "id" FROM "workspaces" ORDER BY "created_at" ASC LIMIT 1)
  AND ("outbound_config"->'sending'->>'senderAddress') IS NULL;
