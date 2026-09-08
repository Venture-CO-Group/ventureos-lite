import { SettingsShell } from "@/components/settings-shell";
import { SettingsTargets } from "@/components/settings-targets";
import { SettingsQuoteRules } from "@/components/settings-quote-rules";
import { SettingsHealthRules } from "@/components/settings-health-rules";
import { SettingsProjectTemplates } from "@/components/settings-project-templates";
import { ProposalQueue } from "@/components/proposal-queue";
import { requireSuperAdminPage } from "../gate";
import { listTargets } from "@/modules/targets/actions";
import { getQuoteRulesView } from "@/modules/quote-rules/actions";
import { getHealthRules } from "@/modules/revenue/health-actions";
import { listProjectTemplates } from "@/modules/projects/actions";
import { listProposals } from "@/modules/signal/actions";
import { isOwner } from "@/lib/authz";

/**
 * Admin → sales & delivery (P8/3).
 *
 * The numbers the pipeline is measured against, the rules a quote follows,
 * when an account counts as unhealthy, and what a delivery project starts
 * with. Plus the Signal Engine's proposals, which are the one place the
 * software asks for a decision rather than taking one.
 */
export const dynamic = "force-dynamic";

export default async function AdminSalesPage() {
  await requireSuperAdminPage();

  const [owner, targets, quoteRules, healthRules, projectTemplates, proposals] =
    await Promise.all([
      isOwner(),
      listTargets(),
      getQuoteRulesView(),
      getHealthRules(),
      listProjectTemplates(),
      listProposals(),
    ]);

  return (
    <SettingsShell
      group="admin"
      pathname="/settings/admin/sales"
      title="sales &amp; delivery"
      description="Targets, quote behaviour, account health thresholds and milestone templates."
    >
      <SettingsTargets targets={targets} isOwner={owner} />
      <SettingsQuoteRules view={quoteRules} isOwner={owner} />
      <SettingsHealthRules initial={healthRules} isOwner={owner} />
      <SettingsProjectTemplates templates={projectTemplates} />
      <ProposalQueue proposals={proposals} isOwner={owner} />
    </SettingsShell>
  );
}
