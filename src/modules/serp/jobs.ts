import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { resolveIntegration } from "@/modules/integrations/resolve";
import { normalizeDomain } from "@/modules/leads/dedupe";
import { serpProviderFor, positionOf, droppedOutOfTopTen } from "./provider";
import { recordApiUsage } from "@/lib/api-usage";
import { createTaskFromSignal } from "@/modules/tasks/from-signal";

/**
 * Weekly position check (P2/7).
 *
 * Runs one query per enabled keyword and stores the result — including "not
 * found", which is stored as NULL rather than as 101, because a missing rank
 * averaged into a trend as a number is a lie about the trend.
 *
 * A CLIENT falling out of the top ten produces a retention signal. A prospect
 * doing the same does not: we have no relationship to protect there, and the
 * noise would bury the signal that matters.
 */
export async function processKeywordTracking(now: Date = new Date()): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({ where: { deletedAt: null }, select: { id: true } });
  let checked = 0;

  for (const ws of workspaces) {
    const credential = await resolveIntegration(ws.id, "serp.credential");
    const provider = serpProviderFor(credential);
    // Dormant without a key: this is the whole point of the null provider.
    if (!provider.configured) continue;

    const db = getWorkspaceClient(ws.id);
    const keywords = await db.trackedKeyword.findMany({
      where: { enabled: true },
      include: {
        company: {
          select: {
            id: true,
            domain: true,
            website: true,
            leads: {
              select: { id: true, outcomes: { where: { result: "WON" }, take: 1 } },
            },
          },
        },
        positions: { orderBy: { checkedAt: "desc" }, take: 1 },
      },
    });

    for (const k of keywords) {
      const domain = k.company.domain ?? normalizeDomain(k.company.website ?? "");
      if (!domain) continue;

      let position: number | null = null;
      let url: string | null = null;
      try {
        const res = await provider.search({
          keyword: k.keyword,
          locale: k.locale,
          location: k.location,
        });
        position = positionOf(res.results, domain);
        url = res.results.find((r) => r.position === position)?.url ?? null;
        // Recorded on SUCCESS only: a failed query below is skipped without a
        // measurement, and DataForSEO does not bill for one either.
        await recordApiUsage({
          workspaceId: ws.id,
          provider: "dataforseo",
          operation: "serp.organic",
          calls: 1,
          costUsd: res.costUsd,
        });
      } catch {
        // A provider outage must not write a false "dropped out of the
        // rankings" row — skip the measurement entirely.
        continue;
      }

      const previous = k.positions[0]?.position ?? null;
      await db.keywordPosition.create({
        data: { workspaceId: ws.id, keywordId: k.id, position, url, checkedAt: now },
      });
      checked += 1;

      const isClient = k.company.leads.some((l) => l.outcomes.length > 0);
      if (isClient && droppedOutOfTopTen(previous, position)) {
        const leadId = k.company.leads[0]?.id;
        if (!leadId) continue;
        await db.activity.create({
          data: {
            workspaceId: ws.id,
            leadId,
            type: "keyword_dropped",
            payload: {
              keyword: k.keyword,
              from: previous,
              to: position,
              headline: `Kiesett a top 10-ből: "${k.keyword}" (${previous}. → ${
                position === null ? "100+" : `${position}.`
              })`,
              suggestedTask: "Ügyfél kulcsszava kiesett a top 10-ből — nézd meg, mi változott",
            },
          },
        });

        await createTaskFromSignal(db, {
          workspaceId: ws.id,
          title: `Kiesett a top 10-ből: "${k.keyword}"`,
          note: `${previous}. → ${position === null ? "100+" : `${position}.`} — ügyfél kulcsszava`,
          entityType: "company",
          entityId: k.company.id,
          // One task per keyword, not per company: two terms dropping are two
          // pieces of work.
          source: `keyword_dropped:${k.id}`,
          dueInDays: 2,
        });
      }
    }
  }

  return checked;
}
