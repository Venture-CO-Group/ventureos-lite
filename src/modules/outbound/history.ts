/**
 * The outbound history (tracking & recovery): every candidate the motor has
 * touched, by where it ended up, with who decided and why — and the detail
 * behind one of them. Session-free; the page and the tests share it.
 */
import type { CandidateReason, CandidateState, Prisma } from "@prisma/client";
import type { WorkspaceClient } from "@/lib/db";
import { prismaUnsafe } from "@/lib/db";
import { cachedDatasheet } from "@/modules/registry/registry-service";
import type { CompanyDatasheet } from "@/modules/registry/datasheet";
import { parseOutboundConfig } from "./config";
import { isHumanEdited } from "./draft";
import type { ResolvedContact } from "./contact";

export const HISTORY_TABS = [
  { key: "pending", label: "Pending approval", states: ["PENDING_APPROVAL"] },
  { key: "sent", label: "Sent", states: ["APPROVED", "SENT"] },
  { key: "rejected", label: "Rejected", states: ["REJECTED"] },
  { key: "filtered", label: "Filtered out", states: ["FILTERED_OUT"] },
  { key: "linkedin", label: "LinkedIn queue", states: ["LINKEDIN_QUEUE"] },
  { key: "replied", label: "Replied", states: ["REPLIED"] },
] as const satisfies ReadonlyArray<{ key: string; label: string; states: readonly CandidateState[] }>;

export type HistoryTab = (typeof HISTORY_TABS)[number]["key"];

export interface HistoryFilters {
  tab: HistoryTab;
  productId?: string | null;
  /** The campaign: an ICP profile. */
  profileId?: string | null;
  from?: Date | null;
  to?: Date | null;
  reason?: CandidateReason | null;
  segment?: string | null;
  q?: string | null;
  sort?: "decided" | "company" | "product";
  dir?: "asc" | "desc";
  page?: number;
}

export const PAGE_SIZE = 50;

export interface FollowupState {
  touchesSent: number;
  lastSentAt: string | null;
  /** The next touch: when it is scheduled, and whether it is drafted and waiting. */
  next: { step: number; dueAt: string; drafted: boolean; status: string | null } | null;
  stoppedOnReply: boolean;
  cancelled: boolean;
  bounced: boolean;
}

export interface HistoryRow {
  candidateId: string;
  company: string;
  contactName: string | null;
  contactEmail: string | null;
  product: string;
  campaign: string;
  state: CandidateState;
  decidedAt: string | null;
  decidedBy: string | null;
  reason: CandidateReason | null;
  reasonDetail: string | null;
  segment: string | null;
  restored: boolean;
  followup: FollowupState | null;
}

/** Case-insensitive on Postgres, default collation on MySQL (see search/actions). */
function like(value: string): { contains: string; mode?: "insensitive" } {
  const insensitive = (process.env.DB_FLAVOR ?? "postgres") === "postgres";
  return insensitive ? { contains: value, mode: "insensitive" } : { contains: value };
}

export function historyWhere(f: HistoryFilters): Prisma.ProspectCandidateWhereInput {
  const tab = HISTORY_TABS.find((t) => t.key === f.tab) ?? HISTORY_TABS[0];
  const q = f.q?.trim();
  return {
    state: { in: [...tab.states] },
    ...(f.productId ? { productId: f.productId } : {}),
    ...(f.profileId ? { profileId: f.profileId } : {}),
    ...(f.reason ? { reason: f.reason } : {}),
    ...(f.segment ? { matchedSegment: f.segment } : {}),
    ...(f.from || f.to ? { stateChangedAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    ...(q ? { OR: [{ name: like(q) }, { contactName: like(q) }, { contactEmail: like(q) }] } : {}),
  };
}

export async function followupStates(
  db: WorkspaceClient,
  workspaceId: string,
  candidates: Array<{ id: string; state: CandidateState; followupsCancelledAt: Date | null }>,
): Promise<Map<string, FollowupState>> {
  const out = new Map<string, FollowupState>();
  if (candidates.length === 0) return out;
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { outboundConfig: true } });
  const offsets = parseOutboundConfig(ws?.outboundConfig).followups.offsetsDays;
  const drafts = await db.outreachDraft.findMany({
    where: { candidateId: { in: candidates.map((c) => c.id) }, supersededAt: null },
    orderBy: { step: "asc" },
    select: { candidateId: true, step: true, status: true, sentAt: true, scheduledFor: true, bouncedAt: true },
  });
  for (const c of candidates) {
    const mine = drafts.filter((d) => d.candidateId === c.id);
    const sent = mine.filter((d) => d.status === "SENT");
    const last = sent[sent.length - 1];
    const stoppedOnReply = c.state === "REPLIED";
    const cancelled = !!c.followupsCancelledAt;
    const bounced = sent.some((d) => d.bouncedAt);
    let next: FollowupState["next"] = null;
    if (c.state === "SENT" && !cancelled && !bounced && last?.sentAt) {
      const step = sent.length;
      const waiting = mine.find((d) => d.step === step && (d.status === "PENDING" || d.status === "APPROVED"));
      if (waiting) {
        next = { step, dueAt: (waiting.scheduledFor ?? last.sentAt).toISOString(), drafted: true, status: waiting.status };
      } else if (step <= offsets.length && !mine.some((d) => d.step === step)) {
        next = { step, dueAt: new Date(last.sentAt.getTime() + offsets[step - 1]! * 86_400_000).toISOString(), drafted: false, status: null };
      }
    }
    out.set(c.id, { touchesSent: sent.length, lastSentAt: last?.sentAt?.toISOString() ?? null, next, stoppedOnReply, cancelled, bounced });
  }
  return out;
}

export async function listHistory(
  db: WorkspaceClient,
  workspaceId: string,
  f: HistoryFilters,
): Promise<{ rows: HistoryRow[]; total: number; page: number; pages: number }> {
  const where = historyWhere(f);
  const page = Math.max(1, f.page ?? 1);
  const dir = f.dir ?? "desc";
  const orderBy: Prisma.ProspectCandidateOrderByWithRelationInput[] =
    f.sort === "company" ? [{ name: dir }] : f.sort === "product" ? [{ productId: dir }, { stateChangedAt: "desc" }] : [{ stateChangedAt: dir }, { id: "asc" }];
  const [total, cands] = await Promise.all([
    db.prospectCandidate.count({ where }),
    db.prospectCandidate.findMany({ where, orderBy, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
  ]);
  const [products, profiles, users] = await Promise.all([
    db.product.findMany({ select: { id: true, name: true } }),
    db.icpProfile.findMany({ select: { id: true, name: true } }),
    prismaUnsafe.user.findMany({
      where: { id: { in: cands.map((c) => c.stateChangedById).filter((x): x is string => !!x) } },
      select: { id: true, name: true, email: true },
    }),
  ]);
  const followups = f.tab === "sent" || f.tab === "replied" ? await followupStates(db, workspaceId, cands) : new Map<string, FollowupState>();
  const rows: HistoryRow[] = cands.map((c) => {
    const u = users.find((x) => x.id === c.stateChangedById);
    return {
      candidateId: c.id,
      company: c.name,
      contactName: c.contactName,
      contactEmail: c.contactEmail,
      product: products.find((p) => p.id === c.productId)?.name ?? "—",
      campaign: profiles.find((p) => p.id === c.profileId)?.name ?? "—",
      state: c.state,
      decidedAt: c.stateChangedAt?.toISOString() ?? null,
      decidedBy: c.stateChangedById ? (u?.name ?? u?.email ?? "a user") : "system",
      reason: c.reason,
      reasonDetail: c.reasonDetail,
      segment: c.matchedSegment,
      restored: !!c.restoredAt,
      followup: followups.get(c.id) ?? null,
    };
  });
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

// ---- one candidate -----------------------------------------------------------------

export interface CandidateDetail {
  id: string;
  name: string;
  state: CandidateState;
  reason: CandidateReason | null;
  reasonDetail: string | null;
  product: string;
  campaign: string;
  taxNumber: string | null;
  website: string | null;
  segment: string | null;
  restored: { at: string; by: string; note: string | null; count: number } | null;
  contact: ResolvedContact | null;
  events: Array<{ at: string; from: CandidateState | null; to: CandidateState; reason: CandidateReason | null; detail: string | null; actor: string; retracted: boolean }>;
  sheet: { data: CompanyDatasheet; fetchedAt: string } | null;
  audit: { id: string; score: number; flags: string[]; url: string; at: string } | null;
  drafts: Array<{
    id: string;
    step: number;
    status: string;
    subject: string;
    body: string;
    edited: boolean;
    originalSubject: string;
    originalBody: string;
    createdAt: string;
    decidedAt: string | null;
    decidedBy: string | null;
    rejectReason: CandidateReason | null;
    rejectNote: string | null;
    scheduledFor: string | null;
    sentAt: string | null;
    sentFrom: string | null;
    bouncedAt: string | null;
    sendError: string | null;
    superseded: boolean;
  }>;
  followup: FollowupState | null;
  reply: { at: string; from: string; snippet: string | null; threadId: string } | null;
}

export async function loadCandidateDetail(db: WorkspaceClient, workspaceId: string, candidateId: string): Promise<CandidateDetail | null> {
  const c = await db.prospectCandidate.findUnique({ where: { id: candidateId } });
  if (!c) return null;
  const [events, drafts, product, profile, audit] = await Promise.all([
    db.candidateEvent.findMany({ where: { candidateId }, orderBy: { at: "asc" } }),
    db.outreachDraft.findMany({ where: { candidateId }, orderBy: [{ step: "asc" }, { createdAt: "asc" }] }),
    c.productId ? db.product.findUnique({ where: { id: c.productId }, select: { name: true } }) : null,
    c.profileId ? db.icpProfile.findUnique({ where: { id: c.profileId }, select: { name: true } }) : null,
    c.auditId ? db.auditResult.findUnique({ where: { id: c.auditId } }) : null,
  ]);
  const userIds = [...events.map((e) => e.userId), ...drafts.map((d) => d.decidedById), c.restoredById].filter((x): x is string => !!x);
  const users = await prismaUnsafe.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } });
  const who = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? users.find((u) => u.id === id)?.email ?? "a user") : "system");
  const sheet = c.taxNumber ? await cachedDatasheet(workspaceId, c.taxNumber) : null;
  const followup = (await followupStates(db, workspaceId, [c])).get(c.id) ?? null;
  const first = drafts.find((d) => d.status === "SENT" && d.step === 0);
  const domain = first?.toAddress.split("@")[1];
  const reply = first?.sentAt
    ? await db.emailMessage.findFirst({
        where: {
          direction: "INBOUND",
          sentAt: { gt: first.sentAt },
          OR: [{ fromAddress: first.toAddress }, ...(domain ? [{ fromAddress: { endsWith: `@${domain}` } }] : [])],
        },
        orderBy: { sentAt: "asc" },
        select: { sentAt: true, fromAddress: true, snippet: true, threadId: true },
      })
    : null;
  return {
    id: c.id,
    name: c.name,
    state: c.state,
    reason: c.reason,
    reasonDetail: c.reasonDetail,
    product: product?.name ?? "—",
    campaign: profile?.name ?? "—",
    taxNumber: c.taxNumber,
    website: c.website,
    segment: c.matchedSegment,
    restored: c.restoredAt ? { at: c.restoredAt.toISOString(), by: who(c.restoredById), note: c.restoreNote, count: c.restoreCount } : null,
    contact: (c.contact ?? null) as ResolvedContact | null,
    events: events.map((e) => ({
      at: e.at.toISOString(),
      from: e.fromState,
      to: e.toState,
      reason: e.reason,
      detail: e.detail,
      actor: who(e.userId),
      retracted: !!e.retractedAt,
    })),
    sheet: sheet ? { data: sheet.sheet, fetchedAt: sheet.fetchedAt.toISOString() } : null,
    audit: audit
      ? { id: audit.id, score: audit.score, flags: Array.isArray(audit.flags) ? (audit.flags as string[]) : [], url: audit.url, at: audit.createdAt.toISOString() }
      : null,
    drafts: drafts.map((d) => ({
      id: d.id,
      step: d.step,
      status: d.status,
      subject: d.subject,
      body: d.body,
      edited: isHumanEdited(d),
      originalSubject: d.originalSubject,
      originalBody: d.originalBody,
      createdAt: d.createdAt.toISOString(),
      decidedAt: d.decidedAt?.toISOString() ?? null,
      decidedBy: d.decidedById ? who(d.decidedById) : null,
      rejectReason: d.rejectReason,
      rejectNote: d.rejectNote,
      scheduledFor: d.scheduledFor?.toISOString() ?? null,
      sentAt: d.sentAt?.toISOString() ?? null,
      sentFrom: d.sentFrom,
      bouncedAt: d.bouncedAt?.toISOString() ?? null,
      sendError: d.sendError,
      superseded: !!d.supersededAt,
    })),
    followup,
    reply: reply ? { at: reply.sentAt.toISOString(), from: reply.fromAddress, snippet: reply.snippet, threadId: reply.threadId } : null,
  };
}
