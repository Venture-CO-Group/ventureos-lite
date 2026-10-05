/**
 * The approval queue's cards (spec §4.43.8): each one carries the message as
 * it will be sent — signature and unsubscribe line included — and everything
 * that explains WHY this company: how the address was found, the registry
 * facts, the audit finding used, the product and the profile.
 */
import { prismaUnsafe, type WorkspaceClient } from "@/lib/db";
import { cachedDatasheet } from "@/modules/registry/registry-service";
import { brandFrom } from "@/modules/workspaces/brand";
import { parseOutboundConfig, COLD_OUTBOUND_ADDRESS } from "./config";
import { composeMessage, signatureFor, PREVIEW_UNSUBSCRIBE_URL } from "./compose";
import { highlightRanges, type PersonalisationPoint } from "./draft";
import type { CandidateFact } from "./facts";
import type { ResolvedContact } from "./contact";
import { formatFt } from "./filter";

export interface QueueCard {
  draftId: string;
  candidateId: string;
  step: number;
  subject: string;
  body: string;
  /** body + signature + unsubscribe line: the whole outgoing text. */
  outgoing: string;
  signature: string;
  highlights: Array<{ start: number; end: number; factId: string }>;
  points: PersonalisationPoint[];
  facts: CandidateFact[];
  edited: boolean;
  originalSubject: string;
  originalBody: string;
  openedByMe: boolean;
  to: { address: string; name: string | null; kind: string; source: string | null; verify: string | null; trail: string[] };
  company: {
    name: string;
    taxNumber: string | null;
    city: string | null;
    employees: number | null;
    revenue: string | null;
    founded: string | null;
    activity: string | null;
    website: string | null;
  };
  audit: { id: string; score: number } | null;
  product: string;
  profile: string;
  mode: string;
  scheduledFor: string | null;
  createdAt: string;
  /** A second look: restored from Rejected or Filtered out. */
  restored: { at: string; note: string | null } | null;
}

export async function loadQueue(db: WorkspaceClient, workspaceId: string, userId: string, take = 60): Promise<QueueCard[]> {
  const drafts = await db.outreachDraft.findMany({
    where: { status: "PENDING" },
    orderBy: [{ step: "desc" }, { createdAt: "asc" }],
    take,
  });
  if (drafts.length === 0) return [];
  const cands = await db.prospectCandidate.findMany({ where: { id: { in: drafts.map((d) => d.candidateId) } } });
  const profileIds = [...new Set(cands.map((c) => c.profileId).filter((x): x is string => !!x))];
  const [profiles, products, audits, ws, sender] = await Promise.all([
    db.icpProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, name: true, mode: true } }),
    db.product.findMany({ select: { id: true, name: true } }),
    db.auditResult.findMany({
      where: { id: { in: cands.map((c) => c.auditId).filter((x): x is string => !!x) } },
      select: { id: true, score: true },
    }),
    prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { outboundConfig: true, brand: true } }),
    prismaUnsafe.mailAccount.findFirst({ where: { workspaceId, accountEmail: COLD_OUTBOUND_ADDRESS }, select: { userId: true } }),
  ]);
  const senderUser = sender ? await prismaUnsafe.user.findUnique({ where: { id: sender.userId }, select: { name: true } }) : null;
  const cfg = parseOutboundConfig(ws?.outboundConfig);
  const brand = brandFrom(ws?.brand);
  const signature = signatureFor(cfg.sending, { senderName: senderUser?.name ?? "", company: brand.name });

  const out: QueueCard[] = [];
  for (const d of drafts) {
    const c = cands.find((x) => x.id === d.candidateId);
    if (!c) continue;
    const sheet = c.taxNumber ? (await cachedDatasheet(workspaceId, c.taxNumber))?.sheet ?? null : null;
    const contact = (c.contact ?? null) as ResolvedContact | null;
    const pts = Array.isArray(d.personalisationPoints) ? (d.personalisationPoints as unknown as PersonalisationPoint[]) : [];
    const profile = profiles.find((p) => p.id === c.profileId);
    const audit = audits.find((a) => a.id === c.auditId);
    out.push({
      draftId: d.id,
      candidateId: c.id,
      step: d.step,
      subject: d.subject,
      body: d.body,
      outgoing: composeMessage({ body: d.body, signature, language: d.language, unsubscribeUrl: PREVIEW_UNSUBSCRIBE_URL }),
      signature,
      highlights: highlightRanges(d.body, pts),
      points: pts,
      facts: Array.isArray(c.facts) ? (c.facts as unknown as CandidateFact[]) : [],
      edited: d.edited,
      originalSubject: d.originalSubject,
      originalBody: d.originalBody,
      openedByMe: d.openedById === userId,
      to: {
        address: d.toAddress,
        name: d.toName,
        kind: contact?.kind ?? "unknown",
        source: contact?.source ?? null,
        verify: contact?.verify ? `${contact.verify.status} (${contact.verify.reason})` : null,
        trail: contact?.trail ?? [],
      },
      company: {
        name: c.name,
        taxNumber: c.taxNumber,
        city: sheet?.seat.city ?? null,
        employees: sheet?.employeeCount ?? null,
        revenue: sheet?.netRevenue !== null && sheet?.netRevenue !== undefined ? `${formatFt(sheet.netRevenue)}${sheet.financialYear ? ` (${sheet.financialYear})` : ""}` : null,
        founded: sheet?.foundedAt ?? null,
        activity: sheet?.principalActivity ? `${sheet.principalActivity.code} ${sheet.principalActivity.label ?? ""}`.trim() : null,
        website: c.website,
      },
      audit: audit ? { id: audit.id, score: audit.score } : null,
      product: products.find((p) => p.id === d.productId)?.name ?? "—",
      profile: profile?.name ?? "—",
      mode: profile?.mode ?? "VOLUME",
      scheduledFor: d.scheduledFor?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
      restored: c.restoredAt ? { at: c.restoredAt.toISOString(), note: c.restoreNote } : null,
    });
  }
  return out;
}

export interface LinkedInCard {
  candidateId: string;
  company: string;
  managerName: string | null;
  website: string | null;
  facts: CandidateFact[];
  /** A starting line built from the strongest fact — no AI, the Studio drafts. */
  opener: string;
  searchUrl: string;
  leadId: string | null;
  product: string;
  at: string;
}

export function linkedInOpener(company: string, manager: string | null, facts: readonly CandidateFact[]): string {
  const fact = facts.find((f) => f.kind === "audit") ?? facts.find((f) => f.kind === "site") ?? facts.find((f) => f.id.startsWith("registry:"));
  const hello = manager ? `Kedves ${manager.split(" ").slice(-1)[0]}!` : "Üdvözlöm!";
  return fact
    ? `${hello} A ${company} kapcsán feltűnt: ${fact.label.toLowerCase()} — ${fact.value}. Szívesen megmutatnám, mit javasolnánk, ha nyitott egy rövid beszélgetésre.`
    : `${hello} Szívesen kapcsolódnék a ${company} kapcsán.`;
}

export async function loadLinkedInQueue(db: WorkspaceClient, take = 100): Promise<LinkedInCard[]> {
  const cands = await db.prospectCandidate.findMany({
    where: { state: "LINKEDIN_QUEUE" },
    orderBy: { updatedAt: "desc" },
    take,
  });
  const products = await db.product.findMany({ select: { id: true, name: true } });
  return cands.map((c) => {
    const contact = (c.contact ?? null) as ResolvedContact | null;
    const facts = Array.isArray(c.facts) ? (c.facts as unknown as CandidateFact[]) : [];
    const manager = contact?.managerName ?? null;
    return {
      candidateId: c.id,
      company: c.name,
      managerName: manager,
      website: c.website,
      facts,
      opener: linkedInOpener(c.name, manager, facts),
      searchUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent([manager, c.name].filter(Boolean).join(" "))}`,
      leadId: c.leadId,
      product: products.find((p) => p.id === c.productId)?.name ?? "—",
      at: c.updatedAt.toISOString(),
    };
  });
}
