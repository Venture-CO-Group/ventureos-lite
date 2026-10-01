/**
 * The outbound motor's contribution to the weekly Signal Engine run
 * (playbook-v6 F6/4). Aggregates for the digest, and fragment-retirement
 * proposals computed by arithmetic — the model writes about them, it does not
 * decide them, and an Owner approves each one. Nothing self-modifies.
 */
import type { WorkspaceClient } from "@/lib/db";
import type { DimStat, ProposalDraft } from "@/modules/signal/logic";
import { fragmentRetirementCandidates, outboundFunnel } from "./metrics";

export async function outboundSignal(db: WorkspaceClient, since: Date): Promise<{ stats: DimStat[]; proposals: ProposalDraft[] }> {
  const funnel = await outboundFunnel(db, since);
  const stats: DimStat[] = funnel.products
    .filter((p) => p.sourced > 0)
    .map((p) => ({
      key: `outbound_product:${p.productName}`,
      n: p.drafted,
      sent: p.sent,
      // Approval is not acceptance; it is reported in the key's own line.
      accepted: 0,
      replied: p.replied,
      won: 0,
      lost: 0,
      revenue: 0,
      acceptRate: 0,
      replyRate: p.sent ? p.replied / p.sent : 0,
      closeRate: 0,
    }));
  const retire = await fragmentRetirementCandidates(db);
  const proposals: ProposalDraft[] = retire.map((r) => ({
    kind: "FRAGMENT_RETIREMENT",
    title: `Retire the name fragment “${r.fragment}” in ${r.segmentKey}`,
    evidence: `${r.decided} decided candidates found by this fragment, none approved (${r.sourced} pool companies).`,
    n: r.decided,
    data: { segmentKey: r.segmentKey, fragment: r.fragment },
  }));
  return { stats, proposals };
}
