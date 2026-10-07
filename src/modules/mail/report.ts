import { prismaUnsafe, getWorkspaceClient } from "../../lib/db";
import { getMailProvider } from "./provider";
import { resolveSendingIdentity } from "./identity";
import { getTopReferrers } from "../referrals/data";
import { brandFrom } from "@/modules/workspaces/brand";
import { brandEmail, brandEmailText } from "./layout";

function huf(n: number): string {
  return `${n.toLocaleString("en-US").replace(/,/g, " ")} Ft`;
}

/**
 * Friday report delivery path (spec §4.14/§4.11). The analytics content is
 * filled by the Analytics module later; this is the send path — one email per
 * workspace to its Owner(s), via the same transactional provider.
 */
export async function sendFridayReport(workspaceId: string): Promise<void> {
  const db = getWorkspaceClient(workspaceId);
  const [leads, meetings, topReferrers] = await Promise.all([
    db.lead.count(),
    db.meeting.count(),
    getTopReferrers(db, 3),
  ]);

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { mailgunConfig: true, brand: true },
  });
  const brand = brandFrom(ws?.brand);
  const identity = resolveSendingIdentity(ws?.mailgunConfig, brand);

  const owners = await prismaUnsafe.membership.findMany({
    where: { workspaceId, role: "OWNER" },
    include: { user: { select: { email: true } } },
  });

  // The workspace's own name, not the product's: a second workspace's Owner
  // should not receive a report headed by this agency (audit-v2 item 6).
  const reportTitle = `${brand.name} — Friday report`;

  /**
   * Rendered through the brand layout, like every other message this system
   * sends. It used to be three concatenated tags — `<h2>`, a `<p>` and a `<ul>`
   * — which arrive as unstyled browser-default text with no sender identity,
   * no plain-text alternative and no resemblance to the product it reports on.
   */
  const content = {
    preheader: `${leads} leads · ${meetings} meetings`,
    heading: "Friday report",
    paragraphs: ["Where the week landed."],
    metrics: [
      { label: "Leads", value: String(leads) },
      { label: "Meetings", value: String(meetings) },
    ],
    sections: topReferrers.length
      ? [
          {
            // The network as a measurable channel (spec §4.18).
            heading: "Top referrers",
            rows: topReferrers.map((r) => ({
              label: `${r.name} · ${r.won}/${r.referred} won`,
              value: huf(r.attributedRevenue),
            })),
          },
        ]
      : [],
    footNote: "Sent every Friday to the workspace's Owners.",
    brand,
  };
  const html = brandEmail(content);
  const text = brandEmailText(content);
  for (const owner of owners) {
    const { id } = await getMailProvider().send({
      domain: identity.domain,
      to: owner.user.email,
      from: identity.from,
      replyTo: identity.replyTo || undefined,
      subject: reportTitle,
      html,
      text,
    });
    await db.emailLog.create({
      data: { workspaceId, to: owner.user.email, subject: "Friday report", mailgunId: id, status: "QUEUED" },
    });
  }
}

/** Cross-workspace system job (Friday cron). */
export async function processFridayReports(): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({ where: { deletedAt: null }, select: { id: true } });
  for (const w of workspaces) await sendFridayReport(w.id);
  return workspaces.length;
}
