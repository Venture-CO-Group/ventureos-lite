import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { AnalyticsSkeleton } from "@/components/skeletons";
import { Analytics } from "@/components/analytics";
import { AnalyticsTabs } from "@/components/analytics-tabs";
import { RevenueTab } from "@/components/revenue-tab";
import { getAnalytics } from "@/modules/analytics/actions";
import { CommissionTab } from "@/components/commission-tab";
import { ForecastTab } from "@/components/forecast-tab";
import { loadForecast } from "@/modules/deals/forecast-data";
import { loadRevenue } from "@/modules/revenue/dashboard";
import { getActiveContext } from "@/lib/session";
import { isOwner } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * Analytics, now with two surfaces (playbook-v3 P11/1b).
 *
 * Only the chosen tab's data is loaded: the Revenue tab reads the whole
 * subscription event log, and there is no reason to pay for that when someone
 * opened the funnel.
 */
export default function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  return (
    <AppShell activePath="/analytics">
      <Suspense fallback={<AnalyticsSkeleton />}>
        <AnalyticsBody searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}

async function AnalyticsBody({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const owner = await isOwner();
  // A non-Owner asking for the commission tab lands on Performance rather than
  // on an error: the tab is not theirs, and saying so loudly tells them what
  // they are missing.
  const requested =
    tab === "revenue" || tab === "commission" || tab === "forecast" ? tab : "performance";
  const active = requested === "commission" && !owner ? "performance" : requested;

  if (active === "commission") {
    return (
      <div className="mx-auto w-full max-w-[1400px]">
        <AnalyticsTabs active={active} isOwner={owner} />
        <CommissionTab />
      </div>
    );
  }

  if (active === "forecast") {
    const { workspaceId } = await getActiveContext();
    const view = await loadForecast(workspaceId);
    return (
      <div className="mx-auto w-full max-w-[1400px]">
        <AnalyticsTabs active={active} isOwner={owner} />
        <ForecastTab view={view} isOwner={owner} />
      </div>
    );
  }

  if (active === "revenue") {
    const { workspaceId } = await getActiveContext();
    const view = await loadRevenue(workspaceId);
    return (
      <div className="mx-auto w-full max-w-[1400px]">
        <AnalyticsTabs active={active} isOwner={owner} />
        <RevenueTab view={view} />
      </div>
    );
  }

  const view = await getAnalytics();
  return (
    <>
      <div className="mx-auto w-full max-w-[1400px]">
        <AnalyticsTabs active={active} isOwner={owner} />
      </div>
      <Analytics view={view} />
    </>
  );
}
