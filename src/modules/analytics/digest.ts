import { prismaUnsafe, getWorkspaceClient } from "../../lib/db";
import { getMailProvider } from "../mail/provider";
import { resolveSendingIdentity } from "../mail/identity";
import { callClaude } from "../../lib/ai/call-claude";
import {
  WINLOSS_DIGEST_SYSTEM,
  winlossDigestSchema,
  buildDigestMessage,
  type WinLossDigest,
} from "../../lib/ai/prompts/winloss-digest";
import { getOutcomeFacts } from "./data";
import { brandEmail, brandEmailText, type BrandEmailOptions } from "../mail/layout";
import { brandFrom, type WorkspaceBrand } from "@/modules/workspaces/brand";
import { buildWhatCloses } from "./aggregate";

/** Start-of-quarter (UTC) containing `ms`. */
function quarterStart(ms: number): number {
  const d = new Date(ms);
  const qMonth = Math.floor(d.getUTCMonth() / 3) * 3;
  return Date.UTC(d.getUTCFullYear(), qMonth, 1);
}

function prevQuarterRange(nowMs: number): { sinceMs: number; untilMs: number; label: string } {
  const thisQ = quarterStart(nowMs);
  const sinceMs = quarterStart(thisQ - 1); // start of the quarter before this one
  const d = new Date(sinceMs);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return { sinceMs, untilMs: thisQ, label: `Q${q} ${d.getUTCFullYear()}` };
}

/**
 * The digest as brand email.
 *
 * Two things were wrong with what this used to build. It emitted bare `<h2>`,
 * `<p>` and `<ul>` tags — unstyled browser-default text, no sender identity, no
 * plain-text part. And it said "Venture OS" in the heading AND in the subject
 * line of every workspace's mail, so a white-labelled deployment's Owner got a
 * quarterly report from a company they have never heard of.
 */
function buildDigest(
  label: string,
  digest: WinLossDigest | null,
  totals: { deals: number; won: number; lost: number; postponed: number; revenue: number },
  brand: WorkspaceBrand,
): BrandEmailOptions {
  const sections = [];
  if (digest) {
    sections.push({ heading: "What works", bullets: digest.whatWorks });
    if (digest.whatDrags.length) {
      sections.push({ heading: "What drags", bullets: digest.whatDrags });
    }
    sections.push({
      heading: "Next quarter",
      paragraphs: [digest.recommendation],
      emphasis: true,
    });
  }
  return {
    preheader: `${totals.won} won, ${totals.lost} lost — ${label}`,
    heading: `${label} win/loss`,
    // Claude's one-line read of the quarter, when there is one. Without it the
    // numbers still stand on their own, which is why the digest still sends.
    paragraphs: digest ? [digest.headline] : ["The quarter in numbers."],
    metrics: [
      { label: "Deals closed", value: String(totals.deals) },
      { label: "Won", value: String(totals.won), hint: pct(totals.won, totals.deals) },
      { label: "Revenue", value: huf(totals.revenue) },
    ],
    sections,
    rows: [
      { label: "Lost", value: String(totals.lost) },
      { label: "Postponed", value: String(totals.postponed) },
    ],
    footNote: "Sent at the start of each quarter to the workspace's Owners.",
    brand,
  };
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "—" : `${Math.round((part / whole) * 100)}% of closed`;
}

function huf(n: number): string {
  return `${n.toLocaleString("en-US").replace(/,/g, " ")} Ft`;
}

/**
 * Quarterly win/loss digest (spec §4.20). One email per workspace to its
 * Owner(s), summarising the just-ended quarter. Haiku, aggregates only — no
 * lead-level data leaves the DB. Returns the number of workspaces mailed.
 */
export async function processQuarterlyWinLoss(nowMs: number = Date.now()): Promise<number> {
  const { sinceMs, untilMs, label } = prevQuarterRange(nowMs);
  const workspaces = await prismaUnsafe.workspace.findMany({
    where: { deletedAt: null },
    select: { id: true, mailgunConfig: true, brand: true },
  });

  let sent = 0;
  for (const ws of workspaces) {
    const db = getWorkspaceClient(ws.id);
    const { facts, totals } = await getOutcomeFacts(db, { sinceMs, untilMs });
    if (totals.deals === 0) continue; // nothing closed this quarter

    const whatCloses = buildWhatCloses(facts);

    let digest: WinLossDigest | null = null;
    try {
      const { data } = await callClaude<WinLossDigest>({
        useCase: "winloss_digest",
        workspaceId: ws.id,
        system: WINLOSS_DIGEST_SYSTEM,
        schema: winlossDigestSchema,
        messages: [{ role: "user", content: buildDigestMessage(totals, whatCloses) }],
      });
      digest = data as WinLossDigest;
    } catch (e) {
      // Budget/AI failure — still send the numeric digest.
      // eslint-disable-next-line no-console
      console.error(`[digest] win/loss AI failed for ${ws.id}`, e);
    }

    const brand = brandFrom(ws.brand);
    const identity = resolveSendingIdentity(ws.mailgunConfig, brand);
    const owners = await prismaUnsafe.membership.findMany({
      where: { workspaceId: ws.id, role: "OWNER" },
      include: { user: { select: { email: true } } },
    });
    const content = buildDigest(label, digest, totals, brand);
    const html = brandEmail(content);
    const text = brandEmailText(content);
    // The workspace's own name, never the product's.
    const subject = `${brand.name} — ${label} win/loss digest`;
    for (const owner of owners) {
      const { id } = await getMailProvider().send({
        domain: identity.domain,
        to: owner.user.email,
        from: identity.from,
        replyTo: identity.replyTo || undefined,
        subject,
        html,
        text,
      });
      await db.emailLog.create({
        data: { workspaceId: ws.id, to: owner.user.email, subject, mailgunId: id, status: "QUEUED" },
      });
    }
    sent += 1;
  }
  return sent;
}
