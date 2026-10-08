-- Cold outbound's sending address becomes per-workspace configuration
-- (outboundConfig.sending.senderAddress) instead of a constant in code.
--
-- The Venture workspace keeps exactly the identity it had: it is the
-- installation's first workspace (created by the seed), and it gets the
-- address the constant used to hold. Every other workspace starts with none,
-- and sends nothing until an Owner configures its own.
UPDATE "workspaces"
SET "outbound_config" = jsonb_set(
  COALESCE("outbound_config", '{}'::jsonb),
  '{sending}',
  COALESCE("outbound_config"->'sending', '{}'::jsonb)
    || '{"senderAddress": "fanni.viragh@ventureco.agency"}'::jsonb
)
WHERE "id" = (SELECT "id" FROM "workspaces" ORDER BY "created_at" ASC LIMIT 1)
  AND ("outbound_config"->'sending'->>'senderAddress') IS NULL;
