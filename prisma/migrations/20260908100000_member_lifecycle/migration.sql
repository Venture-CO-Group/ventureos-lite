-- The member lifecycle (§1).
--
-- Membership was binary: a row existed, and `suspended_at` was either null or
-- not. That cannot express a pending invitation or an ended membership whose
-- history has to stay readable — so a real state, plus the three tables the
-- rest of the lifecycle hangs off.

CREATE TYPE "MembershipState" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');

ALTER TABLE "memberships" ADD COLUMN "state" "MembershipState" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "memberships" ADD COLUMN "suspended_role" "Role";
ALTER TABLE "memberships" ADD COLUMN "suspended_grants" JSONB;
ALTER TABLE "memberships" ADD COLUMN "removed_at" TIMESTAMP(3);
ALTER TABLE "memberships" ADD COLUMN "removed_by" TEXT;

-- Backfill from the column that used to carry the whole story. Every existing
-- row is either active or suspended; nothing was ever invited or removed,
-- because neither state existed.
UPDATE "memberships" SET "state" = 'SUSPENDED' WHERE "suspended_at" IS NOT NULL;

CREATE INDEX "memberships_workspace_id_state_idx" ON "memberships"("workspace_id", "state");

-- Soft delete for a user account, with a grace period.
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "purge_after" TIMESTAMP(3);

CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'BDR',
    "grants" JSONB NOT NULL DEFAULT '[]',
    "client_company_id" TEXT,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "invited_by" TEXT,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "resend_count" INTEGER NOT NULL DEFAULT 0,
    "last_sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");
CREATE INDEX "invitations_workspace_id_email_idx" ON "invitations"("workspace_id", "email");
CREATE INDEX "invitations_workspace_id_accepted_at_revoked_at_idx" ON "invitations"("workspace_id", "accepted_at", "revoked_at");

CREATE TABLE "membership_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "membership_events_workspace_id_user_id_at_idx" ON "membership_events"("workspace_id", "user_id", "at");
CREATE INDEX "membership_events_workspace_id_at_idx" ON "membership_events"("workspace_id", "at");

CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "teams_workspace_id_name_key" ON "teams"("workspace_id", "name");
CREATE INDEX "teams_workspace_id_archived_at_idx" ON "teams"("workspace_id", "archived_at");

CREATE TABLE "team_members" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "is_lead" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_members_team_id_user_id_key" ON "team_members"("team_id", "user_id");
CREATE INDEX "team_members_workspace_id_user_id_idx" ON "team_members"("workspace_id", "user_id");

ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
