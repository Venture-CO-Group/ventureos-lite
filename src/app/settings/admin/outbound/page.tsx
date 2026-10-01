import { SettingsShell } from "@/components/settings-shell";
import { SettingsOutbound } from "@/components/settings-outbound";
import { RegistryQuotaMeter } from "@/components/registry-quota-meter";
import { requireSuperAdminPage } from "../gate";
import { getOutboundSettings } from "@/modules/outbound/settings-actions";
import { isOwner } from "@/lib/authz";

/**
 * Admin → Outbound (playbook-v6): the registry quota, the nightly run, the
 * caps and the sending guardrails of the outbound motor.
 */
export const dynamic = "force-dynamic";

export default async function AdminOutboundPage() {
  await requireSuperAdminPage();
  const [{ config, meter, mailbox }, owner] = await Promise.all([getOutboundSettings(), isOwner()]);
  return (
    <SettingsShell
      group="admin"
      pathname="/settings/admin/outbound"
      title="outbound"
      description="Registry quota, the nightly run, daily caps and the cold sending guardrails."
    >
      <RegistryQuotaMeter meter={meter} />
      <SettingsOutbound config={config} isOwner={owner} mailbox={mailbox} />
    </SettingsShell>
  );
}
