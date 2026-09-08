import { SettingsShell } from "@/components/settings-shell";
import { SettingsSecurityPolicy } from "@/components/settings-security-policy";
import { AuditLogPanel } from "@/components/audit-log";
import { GdprPanel } from "@/components/gdpr-panel";
import { requireSuperAdminPage } from "../gate";
import { getSecurityPolicy } from "@/modules/workspaces/actions";
import { getAuditRetention } from "@/modules/auditlog/actions";
import { getRetention, listErasableLeads } from "@/modules/gdpr/actions";
import { isOwner, hasGrant } from "@/lib/authz";

/**
 * Admin → security & compliance (P8/3).
 *
 * The three things an auditor asks for, on one page: who has to use a second
 * factor, what has been done in this workspace and by whom, and how personal
 * data leaves. Grouped because they are asked for together — a data-protection
 * question never arrives one panel at a time.
 */
export const dynamic = "force-dynamic";

export default async function AdminSecurityPage() {
  await requireSuperAdminPage();

  const [owner, securityPolicy, canExport, retention, leads] = await Promise.all([
    isOwner(),
    getSecurityPolicy(),
    hasGrant("exports.run"),
    getRetention(),
    listErasableLeads(),
  ]);
  // Owner-only inside the action; the panel renders nothing without it.
  const auditRetention = owner ? await getAuditRetention() : null;

  return (
    <SettingsShell
      group="admin"
      pathname="/settings/admin/security"
      title="security &amp; compliance"
      description="Two-factor policy, the audit log and its retention, GDPR erasure."
    >
      <SettingsSecurityPolicy view={securityPolicy} />
      {owner && auditRetention && <AuditLogPanel retention={auditRetention} />}
      <GdprPanel retention={retention} leads={leads} isOwner={owner} canExport={canExport} />
    </SettingsShell>
  );
}
