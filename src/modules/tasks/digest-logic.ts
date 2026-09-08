/**
 * The start-of-day task email, decided without a database (P8/2).
 *
 * ── WHAT THIS IS MODELLED ON ────────────────────────────────────────────────
 *
 * Asana's morning mail, which works because it answers one question — "what
 * am I supposed to do today" — and answers it in the order a person needs:
 * what is already late, what is due today, what is about to be. Anything else
 * is a report, and a report is not something anybody reads at 8am.
 *
 * ── WHY THE BUCKETING IS PURE ───────────────────────────────────────────────
 *
 * Because the edges are all about dates and every one of them is a real bug
 * waiting to happen: a task due at 23:00 tonight is due TODAY, not overdue and
 * not "soon"; a task due at 00:30 tomorrow is not due today even though it is
 * eight hours away; and "overdue" must not include something due later this
 * afternoon. Bucketing in SQL would put those decisions in three different
 * `where` clauses and they would drift.
 */

export interface DigestTask {
  id: string;
  title: string;
  dueAt: Date | null;
  priority: string;
  boardName: string | null;
  /** The lead or company this task hangs off, for context in the email. */
  entityLabel: string | null;
  blocked: boolean;
}

export interface DigestBuckets {
  overdue: DigestTask[];
  today: DigestTask[];
  soon: DigestTask[];
  /** Assigned since the previous digest — "new on your plate". */
  justAssigned: DigestTask[];
}

/** How far ahead "soon" reaches. Three days covers a weekend from a Friday. */
export const SOON_DAYS = 3;

/** Local midnight for the day `at` falls in, in the given UTC offset. */
export function startOfLocalDay(at: Date, utcOffsetMinutes: number): Date {
  const shifted = new Date(at.getTime() + utcOffsetMinutes * 60_000);
  const midnightShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(midnightShifted - utcOffsetMinutes * 60_000);
}

/**
 * Sort what a person should look at first.
 *
 * Due date, then priority. A task with no date sorts last within its bucket —
 * inside `justAssigned` that is most of them, and the ordering there matters
 * less than the fact that they are listed at all.
 */
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function sortForDigest(tasks: DigestTask[]): DigestTask[] {
  return [...tasks].sort((a, b) => {
    const da = a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const dbt = b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (da !== dbt) return da - dbt;
    return (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
  });
}

export function bucketTasks(
  tasks: DigestTask[],
  now: Date,
  opts: { utcOffsetMinutes?: number; assignedSince?: Date } = {},
): DigestBuckets {
  const offset = opts.utcOffsetMinutes ?? 0;
  const dayStart = startOfLocalDay(now, offset);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const soonEnd = new Date(dayStart.getTime() + (SOON_DAYS + 1) * 86_400_000);

  const buckets: DigestBuckets = { overdue: [], today: [], soon: [], justAssigned: [] };
  for (const t of tasks) {
    if (t.dueAt === null) continue;
    const due = t.dueAt.getTime();
    // Order matters: each task lands in exactly one bucket, and the earliest
    // matching one wins. A list where a task appears twice reads as a bug.
    if (due < dayStart.getTime()) buckets.overdue.push(t);
    else if (due < dayEnd.getTime()) buckets.today.push(t);
    else if (due < soonEnd.getTime()) buckets.soon.push(t);
  }

  return {
    overdue: sortForDigest(buckets.overdue),
    today: sortForDigest(buckets.today),
    soon: sortForDigest(buckets.soon),
    justAssigned: buckets.justAssigned,
  };
}

/** Is there anything worth sending? */
export function isWorthSending(b: DigestBuckets): boolean {
  return (
    b.overdue.length > 0 ||
    b.today.length > 0 ||
    b.soon.length > 0 ||
    b.justAssigned.length > 0
  );
}

/**
 * The subject line, which is most of what gets read.
 *
 * Leads with the number that decides whether the mail is opened. "3 late, 2
 * today" beats "Your tasks" every morning of the week, and a subject that
 * never changes is a subject the eye stops seeing.
 */
export function digestSubject(b: DigestBuckets, workspaceName: string): string {
  const parts: string[] = [];
  if (b.overdue.length > 0) parts.push(`${b.overdue.length} késésben`);
  if (b.today.length > 0) parts.push(`${b.today.length} ma`);
  if (parts.length === 0 && b.soon.length > 0) parts.push(`${b.soon.length} a héten`);
  if (parts.length === 0 && b.justAssigned.length > 0) {
    parts.push(`${b.justAssigned.length} új`);
  }
  return parts.length > 0
    ? `${parts.join(" · ")} — ${workspaceName}`
    : `A mai feladataid — ${workspaceName}`;
}

/** "ma 14:00", "csütörtök", "3 napja" — short enough for a list row. */
export function describeDue(dueAt: Date | null, now: Date, utcOffsetMinutes = 0): string {
  if (!dueAt) return "nincs határidő";
  const dayStart = startOfLocalDay(now, utcOffsetMinutes);
  const days = Math.floor((dueAt.getTime() - dayStart.getTime()) / 86_400_000);
  const time = new Date(dueAt.getTime() + utcOffsetMinutes * 60_000)
    .toISOString()
    .slice(11, 16);
  if (days < -1) return `${Math.abs(days)} napja lejárt`;
  if (days === -1) return "tegnap lejárt";
  if (days === 0) return `ma ${time}`;
  if (days === 1) return `holnap ${time}`;
  return `${days} nap múlva`;
}
