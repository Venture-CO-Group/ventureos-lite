import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SectorReports } from "@/components/sector-reports";
import { listSectorReports } from "@/modules/sector-reports/actions";
import { hasGrant } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * The sector-report builder (playbook-v4 P12/2a) — capability-gated at the page
 * as well as in every action, because it spends money and ends in something
 * published under the company's name.
 *
 * `sector_reports.manage` rather than the Owner role: a BDR commissioning a
 * sector report is doing the job, and an Owner who disagrees can take the
 * capability away from that one person. `notFound()` rather than a refusal
 * message stays, for the reason it always did.
 */
export default async function ReportsAdminPage() {
  if (!(await hasGrant("sector_reports.manage"))) notFound();
  const reports = await listSectorReports();
  return (
    <AppShell activePath="/reports-admin">
      <SectorReports reports={reports} />
    </AppShell>
  );
}
