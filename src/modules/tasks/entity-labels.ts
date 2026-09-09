/**
 * Names for the entity chips (playbook-v5 P20/4).
 *
 * Its own module because two callers need it — the "also linked to" list and
 * the batched detail read — and a `"use server"` file may only export async
 * functions, so a shared helper cannot live beside one of them.
 */

import { getWorkspaceClient } from "@/lib/db";
import type { EntityKind } from "./links";

/**
 * Names for the chips. Resolved here rather than in the store because a label
 * is a presentation concern and each kind lives in a different table.
 */
export async function labelEntityLinks(
  workspaceId: string,
  links: { kind: EntityKind; id: string }[],
): Promise<{ kind: EntityKind; id: string; label: string }[]> {
  if (links.length === 0) return [];
  const db = getWorkspaceClient(workspaceId);
  const idsOf = (k: EntityKind) => links.filter((l) => l.kind === k).map((l) => l.id);

  const [leads, companies, deals, projects] = await Promise.all([
    idsOf("lead").length
      ? db.lead.findMany({
          where: { id: { in: idsOf("lead") } },
          select: { id: true, contactName: true, company: { select: { name: true } } },
        })
      : Promise.resolve([]),
    idsOf("company").length
      ? db.company.findMany({
          where: { id: { in: idsOf("company") } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    idsOf("deal").length
      ? db.deal.findMany({
          where: { id: { in: idsOf("deal") } },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
    idsOf("project").length
      ? db.project.findMany({
          where: { id: { in: idsOf("project") } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const label = new Map<string, string>();
  for (const l of leads) label.set(`lead:${l.id}`, l.contactName || l.company?.name || "lead");
  for (const c of companies) label.set(`company:${c.id}`, c.name);
  for (const d of deals) label.set(`deal:${d.id}`, d.title);
  for (const p of projects) label.set(`project:${p.id}`, p.name);

  return links.map((l) => ({
    ...l,
    // A link whose entity has since been deleted still shows, as "(removed)",
    // rather than vanishing — a task pointing at nothing is worth seeing.
    label: label.get(`${l.kind}:${l.id}`) ?? "(removed)",
  }));
}
