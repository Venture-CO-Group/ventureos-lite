import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { runRulesForQuote, markAcceptedQuotes } from "./store";

/**
 * The daily sweep (playbook-v4 P14/3).
 *
 * Two of the three rules fire on a new reading session and are evaluated the
 * moment one arrives. The third — "opened once, then silence" — fires on the
 * passage of TIME, and nothing arrives to trigger it. Hence a sweep.
 *
 * Bounded: only quotes that were actually sent, are not accepted, and are
 * recent enough to still be live. An eight-month-old unsigned quote is not a
 * follow-up opportunity, it is history.
 */
const LOOKBACK_DAYS = 60;

export async function processQuoteRuleSweep(now: Date = new Date()): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({ where: { deletedAt: null }, select: { id: true } });
  let fired = 0;

  for (const ws of workspaces) {
    const db = getWorkspaceClient(ws.id);

    // Close the loop first: a quote accepted since the last sweep should be
    // credited to whatever fired on it before the next evaluation runs.
    await markAcceptedQuotes(ws.id).catch(() => {
      /* bookkeeping must not stop the sweep */
    });

    const quotes = await db.document.findMany({
      where: {
        type: "QUOTE",
        acceptSlug: { not: null },
        createdAt: { gte: new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000) },
        acceptances: { none: {} },
      },
      select: { id: true },
      take: 500,
    });

    for (const q of quotes) {
      const hits = await runRulesForQuote(ws.id, q.id, now).catch(() => [] as string[]);
      fired += hits.length;
    }
  }
  return fired;
}
