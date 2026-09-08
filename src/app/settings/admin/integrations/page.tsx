import { SettingsShell } from "@/components/settings-shell";
import { SettingsIntegrations } from "@/components/settings-integrations";
import { ApiCosts } from "@/components/api-costs";
import { SettingsWebhooks } from "@/components/settings-webhooks";
import { SzamlazzKey } from "@/components/szamlazz-key";
import { ColdSignoff } from "@/components/cold-signoff";
import { requireSuperAdminPage } from "../gate";
import { getIntegrations } from "@/modules/integrations/actions";
import { listWebhooks } from "@/modules/webhooks/actions";
import { hasSzamlazzKey } from "@/modules/invoicing/actions";
import { getColdStatus } from "@/modules/campaigns/actions";
import { getApiCostReport } from "@/lib/api-usage";
import { isOwner } from "@/lib/authz";
import { getActiveContext } from "@/lib/session";

/**
 * Admin → integrations (P8/3).
 *
 * Every credential in one place, and — directly under them — what those
 * credentials cost. The keys are configured here, so what they spend belongs
 * next to them rather than on a separate page nobody thinks to open.
 */
export const dynamic = "force-dynamic";

export default async function AdminIntegrationsPage() {
  await requireSuperAdminPage();
  const { workspaceId } = await getActiveContext();
  const owner = await isOwner();

  const [integrations, apiCosts, webhooks, szamlazzKeySet, coldStatus] = await Promise.all([
    owner ? getIntegrations() : Promise.resolve(null),
    owner ? getApiCostReport(workspaceId) : Promise.resolve(null),
    listWebhooks(),
    hasSzamlazzKey(),
    getColdStatus(),
  ]);

  return (
    <SettingsShell
      group="admin"
      pathname="/settings/admin/integrations"
      title="integrations"
      description="API keys, what they cost, outbound webhooks and invoicing."
    >
      {integrations && <SettingsIntegrations data={integrations} />}
      {apiCosts && <ApiCosts report={apiCosts} />}
      <SettingsWebhooks view={webhooks} />
      <SzamlazzKey hasKey={szamlazzKeySet} isOwner={owner} />
      <ColdSignoff status={coldStatus} isOwner={owner} />
    </SettingsShell>
  );
}
