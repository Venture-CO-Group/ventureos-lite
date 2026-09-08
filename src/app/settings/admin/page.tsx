import { AppShell } from "@/components/app-shell";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SettingsGrants } from "@/components/settings-grants";
import { SettingsUsers } from "@/components/settings-users";
import { SettingsIntegrations } from "@/components/settings-integrations";
import { ApiCosts } from "@/components/api-costs";
import { SettingsHealthRules } from "@/components/settings-health-rules";
import { SettingsProjectTemplates } from "@/components/settings-project-templates";
import { SettingsQuoteRules } from "@/components/settings-quote-rules";
import { AuditLogPanel } from "@/components/audit-log";
import { SettingsTargets } from "@/components/settings-targets";
import { SettingsAuditWatches } from "@/components/settings-audit-watches";
import { SettingsAuditScoring } from "@/components/settings-audit-scoring";
import { SettingsBranding } from "@/components/settings-branding";
import { SettingsNavVisibility } from "@/components/settings-nav-visibility";
import { SettingsSecurityPolicy } from "@/components/settings-security-policy";
import { SettingsFields } from "@/components/settings-fields";
import { SettingsDataQuality } from "@/components/settings-data-quality";
import { SettingsWorkflows } from "@/components/settings-workflows";
import { ProposalQueue } from "@/components/proposal-queue";
import { GdprPanel } from "@/components/gdpr-panel";
import { WorkspaceAdmin } from "@/components/workspace-admin";
import { ColdSignoff } from "@/components/cold-signoff";
import { SzamlazzKey } from "@/components/szamlazz-key";
import { getColdStatus } from "@/modules/campaigns/actions";
import { hasSzamlazzKey } from "@/modules/invoicing/actions";
import { listMembers } from "@/modules/settings/actions";
import { listProjectTemplates } from "@/modules/projects/actions";
import { getQuoteRulesView } from "@/modules/quote-rules/actions";
import { listTargets } from "@/modules/targets/actions";
import { getSecurityStatus } from "@/modules/auth/actions";
import { listWorkspaceUsers } from "@/modules/users/actions";
import { getIntegrations } from "@/modules/integrations/actions";
import { getHealthRules } from "@/modules/revenue/health-actions";
import { getWorkspaceBrand } from "@/modules/workspaces/brand-actions";
import { getHiddenNav, getSecurityPolicy } from "@/modules/workspaces/actions";
import { getAuditScoring } from "@/modules/audit/config-actions";
import { listFieldDefs } from "@/modules/fields/store";
import { getDataQuality } from "@/modules/merge/actions";
import { getWorkflows } from "@/modules/workflow/actions";
import { listProposals } from "@/modules/signal/actions";
import { getRetention, listErasableLeads } from "@/modules/gdpr/actions";
import { isOwner, hasGrant, isSuperAdmin } from "@/lib/authz";
import { getApiCostReport } from "@/lib/api-usage";
import { getActiveContext } from "@/lib/session";

/**
 * Admin settings — THE SOFTWARE.
 *
 * "legyen egy külön admin settings ami a szoftver beállításait tartalmazza —
 * ezt csak én láthatom mint super admin."
 *
 * ── THE GATE ────────────────────────────────────────────────────────────────
 *
 * Super admin, checked here on the server, and `notFound()` rather than a
 * refusal message: a page that answers "you may not see this" tells someone it
 * exists, and this one does not need to.
 *
 * The panels keep every check they already had — each is still Owner-gated
 * server-side, inside its own actions. This gate is ON TOP of those, never
 * instead of them: a page-level check protects a page, and the only thing that
 * protects a mutation is the mutation.
 *
 * ── A CONSEQUENCE WORTH STATING ─────────────────────────────────────────────
 *
 * Workspace-level settings live here too — branding, custom fields, workflows,
 * integrations, that workspace's users. On this installation the super admin is
 * also the Owner of the only workspace, so nothing is lost. If a SECOND
 * workspace is ever added with its own Owner, those panels should move to a
 * third page (`/settings/workspace`, Owner-gated) — otherwise that Owner cannot
 * reach their own letterhead. Flagged rather than pre-built, because building a
 * page for a workspace that does not exist is how you get a page nobody has
 * ever used.
 */
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  if (!(await isSuperAdmin())) notFound();

  const [members, owner, proposals, retention, leads, canExport, coldStatus, securityStatus] =
    await Promise.all([
      listMembers(),
      isOwner(),
      listProposals(),
      getRetention(),
      listErasableLeads(),
      hasGrant("exports.run"),
      getColdStatus(),
      getSecurityStatus(),
    ]);
  // Owner-only; listWorkspaceUsers throws for anyone else, so only ask when owner.
  const managedUsers = owner ? await listWorkspaceUsers() : [];
  const integrations = owner ? await getIntegrations() : null;
  const szamlazzKeySet = await hasSzamlazzKey();
  const { workspaceId } = await getActiveContext();
  // Sits directly under Integrations: the keys are configured there, and what
  // they cost belongs next to them.
  const apiCosts = owner ? await getApiCostReport(workspaceId) : null;
  // Workspace-wide, Owner-edited: the thresholds decide who lands on a list the
  // whole team works from (P11/1c).
  const healthRules = await getHealthRules();
  const projectTemplates = await listProjectTemplates();
  const hiddenNav = await getHiddenNav();
  const auditScoring = await getAuditScoring();
  const securityPolicy = await getSecurityPolicy();
  const quoteRules = await getQuoteRulesView();
  const targets = await listTargets();
  // Workspace-wide letterhead (audit-v2 item 6).
  const brand = await getWorkspaceBrand();
  // Owner-defined fields (P5/1).
  const customFields = await listFieldDefs(workspaceId);
  const canManageFields = await hasGrant("fields.manage");
  const dataQuality = await getDataQuality();
  const workflows = await getWorkflows();

  return (
    <AppShell activePath="/settings">
      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-bold lowercase tracking-display">
              admin settings
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted">
              How the software behaves. Visible to super admins only.
            </p>
          </div>
          <Link
            href="/settings"
            className="min-h-[40px] rounded-[9px] border border-line bg-panel px-3.5 py-2 text-[12.5px] font-semibold text-ink hover:border-accent"
          >
            ← Your settings
          </Link>
        </div>

        <SettingsBranding initial={brand} isOwner={owner} />
        <SettingsSecurityPolicy view={securityPolicy} />
        <SettingsNavVisibility hidden={hiddenNav} isOwner={owner} />
        <SettingsFields defs={customFields} canManage={canManageFields} />
        <SettingsDataQuality view={dataQuality} />
        <SettingsWorkflows view={workflows} />
        <SettingsHealthRules initial={healthRules} isOwner={owner} />
        <SettingsProjectTemplates templates={projectTemplates} />
        <SettingsTargets targets={targets} isOwner={owner} />
        <SettingsQuoteRules view={quoteRules} isOwner={owner} />
        <SettingsAuditScoring view={auditScoring} />
        <SettingsAuditWatches />
        {owner && <AuditLogPanel />}
        {owner && (
          <SettingsUsers
            users={managedUsers}
            minPasswordLength={securityStatus.minPasswordLength}
          />
        )}
        {integrations && <SettingsIntegrations data={integrations} />}
        {apiCosts && <ApiCosts report={apiCosts} />}
        <WorkspaceAdmin isOwner={owner} />
        <ColdSignoff status={coldStatus} isOwner={owner} />
        <SzamlazzKey hasKey={szamlazzKeySet} isOwner={owner} />
        <ProposalQueue proposals={proposals} isOwner={owner} />
        <SettingsGrants members={members} isOwner={owner} />
        <GdprPanel retention={retention} leads={leads} isOwner={owner} canExport={canExport} />
      </div>
    </AppShell>
  );
}
