import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getMailProvider } from "../mail/provider";
import { brandEmail, brandEmailText } from "../mail/layout";
import { resolveSendingIdentity } from "../mail/identity";
import { brandFrom } from "../workspaces/brand";
import { appLink } from "@/lib/public-links";
import { resolveChannels } from "../notifications/types";
import {
  SOON_DAYS,
  bucketTasks,
  describeDue,
  digestSubject,
  isWorthSending,
  sortForDigest,
  type DigestBuckets,
  type DigestTask,
} from "./digest-logic";

/**
 * The start-of-day task email (P8/2).
 *
 * ── WHY THIS AND NOT MORE PER-EVENT MAIL ────────────────────────────────────
 *
 * The task board already notifies on assignment, in the bell and — since the
 * `emailNow` channel — by email. What it could not do is answer the question
 * somebody actually has at 8am: what am I supposed to be doing today. The bell
 * cannot answer it, because a bell is a list of things that happened, not a
 * list of things that are due.
 *
 * Modelled on Asana's morning mail, which works because it answers that one
 * question in the order a person needs it: what is already late, what is due
 * today, what is about to be, and what landed on you since yesterday.
 *
 * ── QUIET WHEN THERE IS NOTHING ─────────────────────────────────────────────
 *
 * No tasks, no email. A daily message that says "nothing due" trains people to
 * filter the ones that matter, and this is the only mail in the product that
 * goes out on a timer to everybody.
 *
 * ── THE TIMEZONE IS PER PERSON ──────────────────────────────────────────────
 *
 * "Due today" depends on where the reader is. The sweep runs hourly and mails
 * whoever has just reached the hour the digest is sent at in THEIR timezone,
 * which is why `sentAt` needs the dedupe below — an hourly sweep must not mail
 * the same person twelve times.
 */

/** Local hour the digest is aimed at. */
export const DIGEST_HOUR = 7;

/**
 * How the send is remembered, so an hourly sweep sends once a day.
 *
 * A notification row rather than a column on the user: the table already
 * exists, already has a unique dedupe key, and already expires on its own after
 * ninety days. A `lastTaskDigestAt` column would be a second mechanism to keep
 * in step with the first.
 */
const DIGEST_TYPE = "task_due";

function offsetMinutesFor(timezone: string | null, at: Date): number {
  if (!timezone) return 0;
  try {
    // The offset for THIS instant in that zone, so it is right on both sides
    // of a daylight-saving change — which is the whole reason the column
    // stores an IANA name rather than a number.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    // An unparseable zone degrades to UTC rather than throwing. A digest an
    // hour early is a nuisance; a sweep that dies is a feature nobody gets.
    return 0;
  }
}

/** The local hour it is for this person, right now. */
export function localHourFor(timezone: string | null, at: Date): number {
  const shifted = new Date(at.getTime() + offsetMinutesFor(timezone, at) * 60_000);
  return shifted.getUTCHours();
}

export async function processTaskDigests(now: Date = new Date()): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({
    select: { id: true, name: true, mailgunConfig: true, brand: true },
  });

  let sent = 0;
  for (const ws of workspaces) {
    const db = getWorkspaceClient(ws.id);
    const brand = brandFrom(ws.brand);
    const identity = resolveSendingIdentity(ws.mailgunConfig, brand);
    // The workspace's name, never the product's.
    const senderName = ws.name?.trim() || brand.name;

    const members = await prismaUnsafe.membership.findMany({
      where: {
        workspaceId: ws.id,
        suspendedAt: null,
        // A read-only client account has no tasks and no business receiving
        // an internal work digest.
        role: { not: "CLIENT" },
      },
      select: {
        userId: true,
        role: true,
        user: { select: { name: true, email: true, timezone: true } },
      },
    });

    for (const m of members) {
      // Only at the hour their own morning starts.
      if (localHourFor(m.user.timezone, now) !== DIGEST_HOUR) continue;

      /**
       * Does this person want task mail at all?
       *
       * Reuses the existing preference matrix rather than adding a switch of
       * its own: somebody who has turned `task_due` email off has already
       * said what they want, and a second control that ignores the first is
       * how a product ends up mailing people who opted out.
       */
      const pref = await db.notificationPreference.findFirst({
        where: { userId: m.userId, type: DIGEST_TYPE },
        select: { inApp: true, push: true, emailDigest: true, emailNow: true },
      });
      if (!resolveChannels(DIGEST_TYPE, pref, m.role).emailDigest) continue;

      const offset = offsetMinutesFor(m.user.timezone, now);
      const buckets = await collectBuckets(ws.id, m.userId, now, offset);
      if (!isWorthSending(buckets)) continue;

      // Once a day, whatever the sweep does. The date is the discriminator, so
      // tomorrow's digest is a different event rather than a duplicate.
      const dedupeKey = `task_digest:${m.userId}:${localDateKey(now, offset)}`;
      try {
        await db.notification.create({
          data: {
            workspaceId: ws.id,
            userId: m.userId,
            type: DIGEST_TYPE,
            title: "A mai feladataid",
            body: summaryLine(buckets),
            href: "/tasks",
            entityType: "digest",
            dedupeKey,
            // Read in the bell is not the point; the email is. Marked read so
            // it does not sit in the badge next to the real notifications.
            readAt: now,
          },
        });
      } catch (e) {
        // P2002 = already sent today. Anything else is a real failure.
        if ((e as { code?: string }).code === "P2002") continue;
        // eslint-disable-next-line no-console
        console.error(`[task-digest] could not record for ${m.user.email}`, e);
        continue;
      }

      const content = {
        preheader: summaryLine(buckets),
        heading: `A mai feladataid, ${m.user.name?.split(" ")[0] ?? ""}`.trim(),
        paragraphs: [] as string[],
        sections: buildSections(buckets, now, offset),
        button: { label: "Megnyitom a táblát", url: appLink("/tasks") },
        footNote: `${senderName} · Ezt a napi levelet a Beállítások → értesítések alatt tudod kikapcsolni ("Task due or overdue", e-mail).`,
        brand,
      };

      try {
        await getMailProvider().send({
          domain: identity.domain,
          to: m.user.email,
          from: identity.from,
          ...(identity.replyTo ? { replyTo: identity.replyTo } : {}),
          subject: digestSubject(buckets, senderName),
          html: brandEmail(content),
          text: brandEmailText(content),
        });
        sent += 1;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[task-digest] send to ${m.user.email} failed`, e);
      }
    }
  }
  return sent;
}

function localDateKey(now: Date, offsetMinutes: number): string {
  return new Date(now.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function summaryLine(b: DigestBuckets): string {
  const parts: string[] = [];
  if (b.overdue.length) parts.push(`${b.overdue.length} késésben`);
  if (b.today.length) parts.push(`${b.today.length} mára`);
  if (b.soon.length) parts.push(`${b.soon.length} a következő ${SOON_DAYS} napban`);
  if (b.justAssigned.length) parts.push(`${b.justAssigned.length} új`);
  return parts.join(" · ");
}

/**
 * The tasks this person needs to know about, and what blocks them.
 *
 * Deliberately narrow: open, top-level, assigned to them. A subtask appears
 * through its parent, and a task on somebody else's plate is not their morning.
 */
async function collectBuckets(
  workspaceId: string,
  userId: string,
  now: Date,
  offsetMinutes: number,
): Promise<DigestBuckets> {
  const db = getWorkspaceClient(workspaceId);
  const horizon = new Date(now.getTime() + (SOON_DAYS + 2) * 86_400_000);

  const rows = await db.task.findMany({
    where: {
      doneAt: null,
      parentId: null,
      assigneeId: userId,
      dueAt: { not: null, lt: horizon },
    },
    orderBy: [{ dueAt: "asc" }],
    take: 100,
    select: {
      id: true,
      title: true,
      dueAt: true,
      priority: true,
      entityType: true,
      entityId: true,
      board: { select: { name: true } },
    },
  });

  // Assigned in the last day and not yet due — "new on your plate", which is
  // the fourth thing Asana's morning mail tells you and the one that stops a
  // handover going unnoticed.
  const since = new Date(now.getTime() - 86_400_000);
  const fresh = await db.task.findMany({
    where: {
      doneAt: null,
      parentId: null,
      assigneeId: userId,
      createdAt: { gte: since },
      id: { notIn: rows.map((r) => r.id) },
    },
    take: 20,
    select: {
      id: true,
      title: true,
      dueAt: true,
      priority: true,
      entityType: true,
      entityId: true,
      board: { select: { name: true } },
    },
  });

  const all = [...rows, ...fresh];
  const blocked = await blockedIds(
    workspaceId,
    all.map((r) => r.id),
  );
  const label = await entityLabels(workspaceId, all);

  const toDigest = (r: (typeof all)[number]): DigestTask => ({
    id: r.id,
    title: r.title,
    dueAt: r.dueAt,
    priority: r.priority,
    boardName: r.board?.name ?? null,
    entityLabel: r.entityId ? (label.get(r.entityId) ?? null) : null,
    blocked: blocked.has(r.id),
  });

  const buckets = bucketTasks(rows.map(toDigest), now, { utcOffsetMinutes: offsetMinutes });
  return { ...buckets, justAssigned: sortForDigest(fresh.map(toDigest)) };
}

/** Which of these are still waiting on something unfinished. */
async function blockedIds(workspaceId: string, taskIds: string[]): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const db = getWorkspaceClient(workspaceId);
  const deps = await db.taskDependency.findMany({
    where: { taskId: { in: taskIds } },
    select: { taskId: true, blockedById: true },
  });
  if (deps.length === 0) return new Set();
  const blockers = await db.task.findMany({
    where: { id: { in: [...new Set(deps.map((d) => d.blockedById))] } },
    select: { id: true, doneAt: true },
  });
  const open = new Set(blockers.filter((b) => !b.doneAt).map((b) => b.id));
  return new Set(deps.filter((d) => open.has(d.blockedById)).map((d) => d.taskId));
}

/** Lead and company names, so a row says who it is about. */
async function entityLabels(
  workspaceId: string,
  rows: { entityType: string | null; entityId: string | null }[],
): Promise<Map<string, string>> {
  const db = getWorkspaceClient(workspaceId);
  const leadIds = rows.filter((r) => r.entityType === "lead" && r.entityId).map((r) => r.entityId!);
  const companyIds = rows
    .filter((r) => r.entityType === "company" && r.entityId)
    .map((r) => r.entityId!);
  const out = new Map<string, string>();
  if (leadIds.length > 0) {
    for (const l of await db.lead.findMany({
      where: { id: { in: leadIds } },
      select: { id: true, contactName: true, company: { select: { name: true } } },
    })) {
      out.set(l.id, l.contactName || l.company?.name || "lead");
    }
  }
  if (companyIds.length > 0) {
    for (const c of await db.company.findMany({
      where: { id: { in: companyIds } },
      select: { id: true, name: true },
    })) {
      out.set(c.id, c.name);
    }
  }
  return out;
}

/**
 * The email body: one headed block per bucket, in the order a person reads.
 *
 * Late first. Not because it is the biggest number but because it is the only
 * one where the answer is "do this before anything else".
 */
function buildSections(
  b: DigestBuckets,
  now: Date,
  offsetMinutes: number,
): { heading: string; rows: { label: string; value: string }[] }[] {
  const row = (t: DigestTask) => ({
    label: [t.title, t.entityLabel ? `(${t.entityLabel})` : null, t.blocked ? "⏳" : null]
      .filter(Boolean)
      .join(" "),
    value: [describeDue(t.dueAt, now, offsetMinutes), t.boardName].filter(Boolean).join(" · "),
  });

  const out: { heading: string; rows: { label: string; value: string }[] }[] = [];
  if (b.overdue.length > 0) {
    out.push({ heading: `Késésben (${b.overdue.length})`, rows: b.overdue.map(row) });
  }
  if (b.today.length > 0) {
    out.push({ heading: `Ma (${b.today.length})`, rows: b.today.map(row) });
  }
  if (b.soon.length > 0) {
    out.push({
      heading: `A következő ${SOON_DAYS} napban (${b.soon.length})`,
      rows: b.soon.map(row),
    });
  }
  if (b.justAssigned.length > 0) {
    out.push({
      heading: `Új a listádon (${b.justAssigned.length})`,
      rows: b.justAssigned.map(row),
    });
  }
  return out;
}
