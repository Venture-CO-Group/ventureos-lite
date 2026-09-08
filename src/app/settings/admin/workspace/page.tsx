import { SettingsShell } from "@/components/settings-shell";
import { SettingsBranding } from "@/components/settings-branding";
import { SettingsNavVisibility } from "@/components/settings-nav-visibility";
import { SettingsFields } from "@/components/settings-fields";
import { SettingsWorkflows } from "@/components/settings-workflows";
import { SettingsDataQuality } from "@/components/settings-data-quality";
import { requireSuperAdminPage } from "../gate";
import { getWorkspaceBrand } from "@/modules/workspaces/brand-actions";
import { getHiddenNav } from "@/modules/workspaces/actions";
import { listFieldDefs } from "@/modules/fields/store";
import { getWorkflows } from "@/modules/workflow/actions";
import { getDataQuality } from "@/modules/merge/actions";
import { isOwner, hasGrant } from "@/lib/authz";
import { getActiveContext } from "@/lib/session";

/**
 * Admin → workspace (P8/3).
 *
 * What this workspace looks like and what shape its data takes: the
 * letterhead, which menu items exist, the fields on a lead, the automation
 * rules, and the duplicate review. Grouped by the question somebody arrives
 * with rather than by which module the code lives in.
 */
export const dynamic = "force-dynamic";

export default async function AdminWorkspacePage() {
  await requireSuperAdminPage();
  const { workspaceId } = await getActiveContext();

  const [owner, brand, hiddenNav, customFields, canManageFields, workflows, dataQuality] =
    await Promise.all([
      isOwner(),
      getWorkspaceBrand(),
      getHiddenNav(),
      listFieldDefs(workspaceId),
      hasGrant("fields.manage"),
      getWorkflows(),
      getDataQuality(),
    ]);

  return (
    <SettingsShell
      group="admin"
      pathname="/settings/admin/workspace"
      title="workspace"
      description="Letterhead, menu visibility, custom fields, workflow rules and data quality."
    >
      <SettingsBranding initial={brand} isOwner={owner} />
      <SettingsNavVisibility hidden={hiddenNav} isOwner={owner} />
      <SettingsFields defs={customFields} canManage={canManageFields} />
      <SettingsWorkflows view={workflows} />
      <SettingsDataQuality view={dataQuality} />
    </SettingsShell>
  );
}
