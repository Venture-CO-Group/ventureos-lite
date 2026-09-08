import type { PrismaClient } from "@prisma/client";

/**
 * Postgres Row-Level Security (belt-and-braces with the tenant guard).
 *
 * Policies are keyed to workspace membership: a row is visible only when
 *   - its workspace_id equals the session GUC `app.current_workspace`, AND
 *   - the session GUC `app.current_user` is a member of that workspace.
 *
 * The app connects as a NON-superuser role (`app_user`) in production so RLS is
 * actually enforced (superusers bypass RLS). Set the two GUCs per transaction
 * with set_config(..., true). This module applies the role, grants and policies
 * idempotently; it is a no-op story on MySQL (which has no RLS — tenancy there
 * rests solely on the guard).
 */

const APP_ROLE = "app_user";
const APP_PASSWORD = process.env.APP_DB_PASSWORD ?? "app_pw";

// Every tenant-scoped table (snake_case @@map names in schema.prisma).
const BUSINESS_TABLES = [
  "companies",
  // Written by the enrichment worker with a workspace in hand (P8/b).
  "visitor_signals",
  // Delivery after the deal is won (P11/2).
  "project_templates",
  "projects",
  "milestones",
  // Quote-behaviour rule firings (P14/3).
  "quote_rule_runs",
  // Open/click events on mail we sent (P9/1).
  "email_track_events",
  // Sector reports (P12/2). The report itself is tenant data;
  // its downloads are written by anonymous visitors, hence the intake list.
  "sector_reports",
  // Referral requests (P13/3).
  "referral_requests",
  "leads",
  "activities",
  "messages",
  "frames",
  "meetings",
  "insights",
  "proposals",
  "reports",
  "targets",
  "audit_logs",
  "prospect_searches",
  "audit_results",
  "audit_shares",
  "templates",
  "documents",
  "email_logs",
  "calls",
  "campaigns",
  "campaign_steps",
  "campaign_recipients",
  "referrers",
  "registry_data",
  "deal_outcomes",
  "booking_pages",
  "quote_acceptances",
  "invoices",
  "suppressions",
  "claude_usage",
  "content_posts",
  "content_variants",
  "integrations",
  "saved_views",
  "notifications",
  "notification_preferences",
  "push_subscriptions",
  "subscriptions",
  "subscription_events",
  "pipelines",
  "deal_stages",
  "deals",
  "custom_field_defs",
  "merge_records",
  "import_templates",
  "import_batches",
  // Added in P6/2 after a coverage audit found them missing. Every one of them
  // is workspace-scoped and was relying on the Prisma guard alone — which is
  // the belt without the braces, and on MySQL is all there is. The email sync
  // layer in particular held whole conversations with clients.
  "tasks",
  // The board layer around tasks (P8/1). Every one carries workspace_id, so
  // they are ordinary business tables — but a new table that is NOT listed
  // here is a table with no policy at all, which is exactly the failure mode
  // this list exists to prevent.
  "task_boards",
  "task_sections",
  "task_comments",
  "task_followers",
  "mail_accounts",
  "email_threads",
  "email_messages",
  "address_links",
  "audit_watches",
  "tracked_keywords",
  "keyword_positions",
  "log_uploads",
  "api_usage",
  "capture_tokens",
  "undo_entries",
  "workflow_rules",
  "workflow_runs",
];

/**
 * Public-intake tables (P12, P6/2).
 *
 * `public_audits` and `public_audit_consents` are written by ANONYMOUS
 * visitors, before any user context exists, so the membership predicate every
 * other business table uses would refuse the very insert they exist for. They
 * follow the `sessions` shape instead: reachable while no user is set, and
 * membership-scoped the moment one is — so a signed-in tenant can only ever see
 * their own workspace's rows.
 */
const PUBLIC_INTAKE_TABLES = [
  "public_audits",
  "public_audit_consents",
  // A visit is recorded by the anonymous reader of a shared page, before any
  // user context exists — same shape as the two above (playbook-v3 P8/a).
  "page_visits",
  "sector_report_downloads",
];

const CURRENT_WS = "current_setting('app.current_workspace', true)";
const CURRENT_USER = "current_setting('app.current_user', true)";

/**
 * ── THE WORKSPACE ALWAYS, THE MEMBERSHIP WHEN THERE IS A USER ──────────────
 *
 * The workspace half is the one that matters and it is never optional: it is
 * precisely the failure the tenant guard exists to prevent, now enforced by the
 * database as well.
 *
 * The membership half stays, because a second belt must not assume the first
 * one is correct — a connection that declares a workspace it has no membership
 * for gets nothing. It is fed from async-local storage set at the session
 * lookup (src/lib/request-user.ts), which means a BACKGROUND JOB has no user to
 * offer: those run with the variable unset and are scoped by workspace alone.
 * That is the deliberate degradation, and it is safe — a job that has already
 * declared a workspace is in the same position as any guarded query.
 */
function businessTablePolicy(table: string): string[] {
  const predicate = `
    workspace_id = ${CURRENT_WS}
    AND (
      ${CURRENT_USER} IS NULL OR ${CURRENT_USER} = ''
      OR EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.workspace_id = ${table}.workspace_id
          AND m.user_id = ${CURRENT_USER}
      )
    )`;
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS ws_isolation ON ${table}`,
    `CREATE POLICY ws_isolation ON ${table} USING (${predicate}) WITH CHECK (${predicate})`,
  ];
}

function statements(): string[] {
  const out: string[] = [];

  // 1. Non-superuser, non-bypassrls application role.
  out.push(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END
  $$`);

  // 2. Privileges (users has no RLS so login lookups work).
  out.push(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  out.push(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
  );
  out.push(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`,
  );

  // 3. Business tables: membership-keyed isolation.
  for (const table of BUSINESS_TABLES) {
    out.push(...businessTablePolicy(table));
  }

  // 3b. Public-intake tables: anonymous writes allowed, tenant reads scoped.
  for (const table of PUBLIC_INTAKE_TABLES) {
    /**
     * Keyed on the WORKSPACE variable, not the user one.
     *
     * An anonymous visitor submitting an audit or reading a shared quote has no
     * workspace context at all — that is the branch that lets the insert
     * through. Once a workspace IS declared, the row must belong to it, which
     * is the same rule every other business table now follows.
     */
    const predicate = `
      ${CURRENT_WS} IS NULL OR ${CURRENT_WS} = ''
      OR workspace_id = ${CURRENT_WS}`;
    out.push(
      `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
      `DROP POLICY IF EXISTS ws_public_intake ON ${table}`,
      `CREATE POLICY ws_public_intake ON ${table} USING (${predicate}) WITH CHECK (${predicate})`,
    );
  }

  // 4. Auth tables. `sessions` and `login_attempts` are global (no
  //    workspace_id) and hold session tokens, emails and IPs. The app role must
  //    reach them to sign users in, but a session row is only ever readable by
  //    its owner — so a compromised tenant query cannot harvest other users'
  //    sessions. `login_attempts` stays app-writable but unreadable per-user:
  //    the throttle counts rows via the same role, keyed by email/ip, and no
  //    UI ever selects from it.
  out.push(
    `ALTER TABLE sessions ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE sessions FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS session_self ON sessions`,
    // The login path runs before a user context exists, so an unset GUC must
    // still be able to insert/lookup; once set, a session row is owner-only.
    `CREATE POLICY session_self ON sessions USING (
       ${CURRENT_USER} IS NULL OR ${CURRENT_USER} = '' OR user_id = ${CURRENT_USER}
     ) WITH CHECK (
       ${CURRENT_USER} IS NULL OR ${CURRENT_USER} = '' OR user_id = ${CURRENT_USER}
     )`,
  );

  // Reset tokens are consumed before any user context exists, so they follow
  // the same shape as sessions: reachable by the app role, owner-scoped once a
  // user context is set.
  out.push(
    `ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS reset_self ON password_reset_tokens`,
    `CREATE POLICY reset_self ON password_reset_tokens USING (
       ${CURRENT_USER} IS NULL OR ${CURRENT_USER} = '' OR user_id = ${CURRENT_USER}
     ) WITH CHECK (
       ${CURRENT_USER} IS NULL OR ${CURRENT_USER} = '' OR user_id = ${CURRENT_USER}
     )`,
  );

  /**
   * 5. Tenancy-mapping tables: a user sees only their own memberships and the
   *    workspaces they belong to.
   *
   * DELIBERATELY STRICT — no empty-variable escape, unlike sessions above.
   * These are reached only by `prismaUnsafe` (the owner connection), which is
   * how sign-in works before any user context exists. If that connection is
   * ever moved to `app_user`, these two policies will refuse everything and
   * login will stop working: that is the intended failure. Loosening them so a
   * future switch "just works" would mean any workspace-scoped connection could
   * enumerate every membership in the installation.
   */
  out.push(
    `ALTER TABLE memberships ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE memberships FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS member_self ON memberships`,
    `CREATE POLICY member_self ON memberships USING (user_id = ${CURRENT_USER}) WITH CHECK (user_id = ${CURRENT_USER})`,
    `ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE workspaces FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS ws_member ON workspaces`,
    `CREATE POLICY ws_member ON workspaces USING (id IN (SELECT m.workspace_id FROM memberships m WHERE m.user_id = ${CURRENT_USER}))`,
  );

  return out;
}

/**
 * Every table this module claims to protect, by name.
 *
 * Exported so a unit test can compare it against the schema: the coverage gap
 * this list closed in P6/2 existed because nothing checked, and a list nothing
 * checks drifts again the next time a model is added.
 */
export const RLS_COVERED_TABLES: readonly string[] = [
  ...BUSINESS_TABLES,
  ...PUBLIC_INTAKE_TABLES,
  // Handled by their own dedicated policies below the business loop.
  "sessions",
  "password_reset_tokens",
  "memberships",
  "workspaces",
];

/** Apply role + grants + RLS policies. Idempotent. Postgres only. */
export async function applyRls(prisma: PrismaClient): Promise<void> {
  for (const sql of statements()) {
    await prisma.$executeRawUnsafe(sql);
  }
}

/** The DATABASE_URL with the non-superuser app_user credentials swapped in. */
export function appUserDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set");
  const url = new URL(base);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}
