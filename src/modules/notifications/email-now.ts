import { prismaUnsafe } from "@/lib/db";
import { getMailProvider } from "../mail/provider";
import { brandEmail, brandEmailText } from "../mail/layout";
import { resolveSendingIdentity } from "../mail/identity";
import { brandFrom } from "../workspaces/brand";
import { appLink } from "@/lib/public-links";
import { NOTIFICATION_TYPE_DEFS, isNotificationType } from "./types";

/**
 * One notification, one email, right now (P8/2).
 *
 * ── WHY THIS EXISTS AT ALL, GIVEN THE DIGEST ────────────────────────────────
 *
 * The notification design says the email channel batches into a digest rather
 * than sending per event, and that is still the rule for eleven of the
 * thirteen types. It is the wrong rule for exactly one: a task somebody just
 * put on your plate. A handover on Friday afternoon that first surfaces in
 * Monday's digest is a handover that did not happen, and the bell only works
 * for somebody who already has the app open.
 *
 * So this sends, and `Channels.emailNow` decides who for. It defaults on for
 * `task_assigned` and off for everything else, which is the same line Asana
 * draws — and the reason their mail still gets read.
 *
 * ── IT NEVER BREAKS THE THING THAT RAISED IT ────────────────────────────────
 *
 * Same contract as the rest of the notification path: every failure is logged
 * and swallowed. Assigning a task must not fail because a mail provider is
 * having an afternoon.
 */
export async function sendNotificationEmails(
  workspaceId: string,
  userIds: string[],
  input: { type: string; title: string; body?: string | null; href: string },
): Promise<number> {
  if (userIds.length === 0) return 0;
  if (!isNotificationType(input.type)) return 0;

  try {
    const [ws, users] = await Promise.all([
      prismaUnsafe.workspace.findUnique({
        where: { id: workspaceId },
        select: { name: true, mailgunConfig: true, brand: true },
      }),
      prismaUnsafe.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      }),
    ]);
    if (users.length === 0) return 0;

    const brand = brandFrom(ws?.brand);
    const identity = resolveSendingIdentity(ws?.mailgunConfig, brand);
    // The workspace's name, never the product's — a literal product name in a
    // subject is the white-label leak the brand work exists to prevent.
    const senderName = ws?.name?.trim() || brand.name;
    const label = NOTIFICATION_TYPE_DEFS[input.type].label;
    const provider = getMailProvider();

    let sent = 0;
    for (const user of users) {
      const content = {
        preheader: input.body ?? label,
        heading: input.title,
        paragraphs: [
          `Szia ${user.name?.split(" ")[0] ?? "!"}`,
          input.body ?? label,
        ],
        button: { label: "Megnyitom", url: appLink(input.href) },
        footNote: `${senderName} · A levelek gyakoriságát a Beállítások → értesítések alatt tudod állítani.`,
        brand,
      };
      try {
        await provider.send({
          domain: identity.domain,
          to: user.email,
          from: identity.from,
          ...(identity.replyTo ? { replyTo: identity.replyTo } : {}),
          subject: `${label}: ${input.title}`,
          html: brandEmail(content),
          text: brandEmailText(content),
        });
        sent += 1;
      } catch (e) {
        // Per recipient, so one bad address does not cost the others theirs.
        // eslint-disable-next-line no-console
        console.error(`[notify] immediate email to ${user.email} failed`, e);
      }
    }
    return sent;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[notify] immediate email for ${input.type} failed`, e);
    return 0;
  }
}
