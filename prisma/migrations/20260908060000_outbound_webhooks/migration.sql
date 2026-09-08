-- Outbound webhooks (P5/5.2).
--
-- The software could already receive (api/webhooks/mailgun). It could not tell
-- anything else that a lead moved or an offer was accepted.
--
-- `events` is jsonb rather than text[]: the schema has to work on MySQL too
-- (CLAUDE.md — no Postgres-only column types).

CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" JSONB NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "disabled_reason" TEXT,
    "last_status" INTEGER,
    "last_attempt_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhooks_workspace_id_enabled_idx" ON "webhooks"("workspace_id", "enabled");

CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "response_status" INTEGER,
    "error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_deliveries_workspace_id_webhook_id_created_at_idx" ON "webhook_deliveries"("workspace_id", "webhook_id", "created_at");
-- The queue's own index: the sweep asks for pending rows whose backoff has
-- elapsed, across every workspace.
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
