import { SettingsShell } from "@/components/settings-shell";
import { SettingsAuditScoring } from "@/components/settings-audit-scoring";
import { SettingsAuditWatches } from "@/components/settings-audit-watches";
import { requireSuperAdminPage } from "../gate";
import { getAuditScoring } from "@/modules/audit/config-actions";

/**
 * Admin → site audit (P8/3).
 *
 * The opportunity score is a sales tool, and what it is made of is the single
 * most consequential setting in the product — a number quoted to a prospect.
 * It gets its own page rather than sitting fourteenth in a column.
 */
export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await requireSuperAdminPage();
  const scoring = await getAuditScoring();

  return (
    <SettingsShell
      group="admin"
      pathname="/settings/admin/audit"
      title="site audit"
      description="What the opportunity score is made of, and which sites are watched for change."
    >
      <SettingsAuditScoring view={scoring} />
      <SettingsAuditWatches />
    </SettingsShell>
  );
}
