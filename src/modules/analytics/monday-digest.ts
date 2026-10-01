import { prismaUnsafe, getWorkspaceClient } from "../../lib/db";
import { getMailProvider } from "../mail/provider";
import { resolveSendingIdentity } from "../mail/identity";
import { callClaude } from "../../lib/ai/call-claude";
import {
  MONDAY_DIGEST_SYSTEM,
  mondayDigestSchema,
  buildMondayDigestMessage,
  type MondayDigestIntro,
} from "../../lib/ai/prompts/monday-digest";
import { collectDigestData } from "./digest-data";
import { buildDigestModel } from "./reports";
import { brandEmail, brandEmailText } from "../mail/layout";
import { brandFrom } from "@/modules/workspaces/brand";
import { appUrl } from "@/lib/env";
import { buildBriefing, briefingDigestLines } from "@/modules/outbound/briefing";

/**
 * Monday 07:30 per-user, per-workspace digest (spec §4.22). Each membership
 * gets one email built from ITS workspace's data (scoping enforced by the
 * guarded client) with one Haiku call for the intro. Returns emails sent.
 */
export async function processMondayDigests(nowMs: number = Date.now()): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({
    select: { id: true, mailgunConfig: true, brand: true },
  });

  let sent = 0;
  for (const ws of workspaces) {
    const db = getWorkspaceClient(ws.id);
    const brand = brandFrom(ws.brand);
    const identity = resolveSendingIdentity(ws.mailgunConfig, brand);
    // The outbound briefing leads the digest (playbook-v6 F6/3). Built once
    // per workspace: it is the same numbers for every member.
    const outbound = briefingDigestLines(await buildBriefing(db, ws.id, new Date(nowMs)));
    const members = await prismaUnsafe.membership.findMany({
      where: { workspaceId: ws.id },
      include: { user: { select: { name: true, email: true } } },
    });

    for (const m of members) {
      const isOwner = m.role === "OWNER";
      // userId + role so the digest can carry this person's unread
      // notifications (P6/1) — the email channel is this line, not per-event mail.
      const input = await collectDigestData(db, {
        isOwner,
        nowMs,
        userId: m.userId,
        role: m.role,
        workspaceId: ws.id,
      });
      const built = buildDigestModel(input);
      const model = { ...built, sections: [...outbound, ...built.sections] };

      let intro = "Here's your week at a glance.";
      try {
        const { data } = await callClaude<MondayDigestIntro>({
          useCase: "monday_digest",
          workspaceId: ws.id,
          system: MONDAY_DIGEST_SYSTEM,
          schema: mondayDigestSchema,
          messages: [{ role: "user", content: buildMondayDigestMessage(m.user.name ?? "there", model) }],
        });
        intro = (data as MondayDigestIntro).intro;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[digest] intro failed for ${m.user.email}`, e);
      }

      /**
       * The digest as brand email.
       *
       * It used to be `<h2>` + `<p>` + `<ul>`: unstyled browser-default text with
       * no sender identity and no plain-text part, and headed "Venture OS" in
       * both the heading and the subject — so every workspace's members got a
       * Monday digest from a company that may not be theirs.
       *
       * The first three lines of the model become headline numbers, because a
       * digest is read on a phone in the first minute of the week; the rest stay
       * as a label/value list.
       */
      const content = {
        preheader: model.sections
          .slice(0, 2)
          .map((s) => `${s.label} ${s.value}`)
          .join(" · "),
        heading: `Your week, ${m.user.name?.split(" ")[0] ?? "there"}`,
        paragraphs: [intro],
        metrics: model.sections.slice(0, 3).map((s) => ({
          label: s.label,
          value: String(s.value),
        })),
        rows: model.sections.slice(3).map((s) => ({
          label: s.label,
          value: String(s.value),
        })),
        button: appUrl() ? { label: "Open the workspace", url: appUrl() } : undefined,
        footNote: "Sent every Monday morning. Change what you receive in Settings → Notifications.",
        brand,
      };
      const subject = `${brand.name} — your Monday digest`;
      const { id } = await getMailProvider().send({
        domain: identity.domain,
        to: m.user.email,
        from: identity.from,
        replyTo: identity.replyTo || undefined,
        subject,
        html: brandEmail(content),
        text: brandEmailText(content),
      });
      await db.emailLog.create({
        data: { workspaceId: ws.id, to: m.user.email, subject, mailgunId: id, status: "QUEUED" },
      });
      sent += 1;
    }
  }
  return sent;
}
