"use server";

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { isClientRole } from "@/lib/grants";

/**
 * The client portal (P6/6.3).
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * A client who can see their own project and their own documents — and nothing
 * else — is what makes the delivery side of the business sellable. Today the
 * only way a client learns where their website build stands is an email
 * somebody remembers to send.
 *
 * ── HOW NARROW IT IS ────────────────────────────────────────────────────────
 *
 * Everything below is scoped by `clientCompanyId`, read off the acting
 * MEMBERSHIP rather than accepted as an argument. There is no parameter a
 * caller could tamper with, which is the only way to be sure a client cannot
 * ask for a different company's delivery.
 *
 * A CLIENT membership with no company sees nothing at all. That is the safe
 * direction to be wrong in: an Owner who forgets to pick a company gets an
 * empty portal, not somebody else's contract.
 *
 * Documents are filtered to FINALIZED ones. A quote still carrying its DRAFT
 * watermark is a working document — the client seeing a draft price is how a
 * negotiation goes wrong before it starts (hard rule #4).
 */
export interface PortalMilestone {
  id: string;
  title: string;
  dueAt: string | null;
  doneAt: string | null;
  kind: string;
}

export interface PortalProject {
  id: string;
  name: string;
  startedAt: string;
  closedAt: string | null;
  milestones: PortalMilestone[];
}

export interface PortalDocument {
  id: string;
  type: string;
  number: string | null;
  status: string;
  total: string | null;
  finalizedAt: string | null;
  pdfUrl: string | null;
}

export interface PortalView {
  /** Null when this account is not a client, or has no company assigned. */
  company: { id: string; name: string } | null
  projects: PortalProject[];
  documents: PortalDocument[];
  /** Set when the account is a client but nothing has been assigned to it. */
  notice: string | null;
}

const EMPTY: PortalView = { company: null, projects: [], documents: [], notice: null };

export async function getPortalView(): Promise<PortalView> {
  const { workspaceId, userId, role } = await getActiveContext();

  /**
   * Only a client account has a portal.
   *
   * Not a security boundary — everything below is narrower than what an Owner
   * can already see — but a staff member landing on a page built around
   * "your project" with no company attached would be reading an error state,
   * and the honest answer is that the page is not theirs.
   */
  if (!isClientRole(role)) {
    return { ...EMPTY, notice: "Ez a felület kliens-hozzáféréshez készült." };
  }

  const membership = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { clientCompanyId: true },
  });
  const companyId = membership?.clientCompanyId;
  if (!companyId) {
    return {
      ...EMPTY,
      notice: "Ehhez a hozzáféréshez még nincs cég hozzárendelve. Szólj a kapcsolattartódnak.",
    };
  }

  const db = getWorkspaceClient(workspaceId);
  // The guarded client re-checks the workspace, so a company id that belonged
  // to another tenant resolves to nothing rather than to a leak.
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true },
  });
  if (!company) return { ...EMPTY, notice: "A hozzárendelt cég nem található." };

  const projects = await db.project.findMany({
    where: { companyId },
    orderBy: { startedAt: "desc" },
    include: { milestones: { orderBy: { position: "asc" } } },
  });

  // A milestone carries nothing itself: the title, due date and done state all
  // live on its Task. One query for all of them rather than one per row.
  const taskIds = projects.flatMap((p) => p.milestones.map((m) => m.taskId));
  const tasks = taskIds.length
    ? await db.task.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, title: true, dueAt: true, doneAt: true },
      })
    : [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const documents = await db.document.findMany({
    where: {
      /**
       * A document has no company of its own — it hangs off a lead or, once
       * one exists, off the deal. Both are asked, because a chain that started
       * before the deals layer keeps only its lead link.
       */
      OR: [{ lead: { companyId } }, { deal: { companyId } }],
      // Finalized only. A DRAFT watermark means the number is still moving.
      watermark: false,
      finalizedAt: { not: null },
    },
    orderBy: { finalizedAt: "desc" },
    select: {
      id: true,
      type: true,
      number: true,
      status: true,
      totals: true,
      finalizedAt: true,
      pdfUrl: true,
    },
  });

  return {
    company,
    notice: null,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      startedAt: p.startedAt.toISOString(),
      closedAt: p.closedAt?.toISOString() ?? null,
      milestones: p.milestones.map((m) => {
        const task = taskById.get(m.taskId);
        return {
          id: m.id,
          title: task?.title ?? "—",
          dueAt: task?.dueAt?.toISOString() ?? null,
          doneAt: task?.doneAt?.toISOString() ?? null,
          kind: m.kind,
        };
      }),
    })),
    documents: documents.map((d) => ({
      id: d.id,
      type: d.type,
      number: d.number,
      status: d.status,
      total: grossOf(d.totals),
      finalizedAt: d.finalizedAt?.toISOString() ?? null,
      pdfUrl: d.pdfUrl,
    })),
  };
}

/**
 * The gross total, as text, or null.
 *
 * Read off the stored `totals` rather than recomputed: the number the client
 * sees has to be the number the document was rendered with, and a recomputation
 * against today's VAT rate would quietly disagree with the PDF they hold.
 */
function grossOf(totals: unknown): string | null {
  if (!totals || typeof totals !== "object" || Array.isArray(totals)) return null;
  const gross = (totals as Record<string, unknown>).gross;
  if (typeof gross !== "number" || !Number.isFinite(gross)) return null;
  return `${gross.toLocaleString("hu-HU")} Ft`;
}
