/**
 * One entity, summarised for a drawer (playbook-v5 P20/4).
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * `/leads?lead=…`, `/leads?company=…` and `/deals?deal=…` were already being
 * generated — by task cards, by global search, by the project screen — and
 * NONE of them was read. Clicking a company-linked task's chip landed on an
 * unfiltered lead table; clicking a project's deal landed on the board with
 * nothing opened. Making the reverse task panel reachable meant making those
 * links mean something, so this resolves whichever entity the address bar
 * names into a header a shared drawer can render.
 *
 * Deliberately thin: a name, a line under it, a few facts and the links out.
 * The lead keeps its own full modal — this is for the entities that never had
 * a surface.
 */

import { getWorkspaceClient } from "@/lib/db";
import type { EntityKind } from "@/modules/tasks/links";

export interface EntityFact {
  label: string;
  value: string;
  href?: string;
}

export interface EntityHeader {
  kind: EntityKind;
  id: string;
  title: string;
  subtitle: string | null;
  facts: EntityFact[];
  /** Links out of the drawer, in the order a person is likely to want them. */
  actions: { label: string; href: string }[];
}

const huf = (n: number) => `${n.toLocaleString("hu-HU")} Ft`;

export async function companyHeader(
  workspaceId: string,
  id: string,
): Promise<EntityHeader | null> {
  const db = getWorkspaceClient(workspaceId);
  const company = await db.company.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      domain: true,
      city: true,
      industry: true,
      taxId: true,
      clientStatus: true,
    },
  });
  if (!company) return null;

  const [leadCount, deals] = await Promise.all([
    db.lead.count({ where: { companyId: id } }),
    db.deal.findMany({
      where: { companyId: id, status: "OPEN" },
      select: { value: true },
    }),
  ]);
  const openValue = deals.reduce((sum, d) => sum + d.value, 0);

  return {
    kind: "company",
    id: company.id,
    title: company.name,
    subtitle: [company.domain, company.city].filter(Boolean).join(" · ") || null,
    facts: [
      { label: "Status", value: company.clientStatus.toLowerCase() },
      ...(company.industry ? [{ label: "Industry", value: company.industry }] : []),
      ...(company.taxId ? [{ label: "Adószám", value: company.taxId }] : []),
      { label: "People", value: `${leadCount}` },
      ...(deals.length
        ? [{ label: "Open deals", value: `${deals.length} · ${huf(openValue)}` }]
        : []),
    ],
    actions: [{ label: "Open the deals board", href: "/deals" }],
  };
}

export async function dealHeader(workspaceId: string, id: string): Promise<EntityHeader | null> {
  const db = getWorkspaceClient(workspaceId);
  const deal = await db.deal.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      value: true,
      status: true,
      expectedCloseAt: true,
      lostReason: true,
      companyId: true,
      company: { select: { name: true } },
      lead: { select: { id: true, contactName: true } },
      pipeline: { select: { name: true } },
      stage: { select: { name: true } },
    },
  });
  if (!deal) return null;

  return {
    kind: "deal",
    id: deal.id,
    title: deal.title,
    subtitle: deal.company?.name ?? deal.lead?.contactName ?? null,
    facts: [
      { label: "Value", value: huf(deal.value) },
      { label: "Stage", value: `${deal.pipeline.name} · ${deal.stage.name}` },
      { label: "Status", value: deal.status.toLowerCase() },
      ...(deal.expectedCloseAt
        ? [{ label: "Expected", value: deal.expectedCloseAt.toLocaleDateString("hu-HU") }]
        : []),
      // A lost deal without its reason on the summary is a summary that hides
      // the only thing worth knowing about it.
      ...(deal.lostReason ? [{ label: "Lost because", value: deal.lostReason }] : []),
    ],
    actions: [
      ...(deal.companyId
        ? [{ label: "Open the company", href: `/leads?company=${deal.companyId}` }]
        : []),
      ...(deal.lead ? [{ label: "Open the lead", href: `/leads?lead=${deal.lead.id}` }] : []),
      { label: "Open the deals board", href: "/deals" },
    ],
  };
}
