/**
 * What a task is about (playbook-v5 P20/4).
 *
 * ── TWO PLACES, ONE READER ──────────────────────────────────────────────────
 *
 * A task's entity lives in `tasks.entity_type` / `tasks.entity_id` — the
 * single-entity fast path, written by roughly twenty callers (signals, audits,
 * referrals, quote rules, workflow triggers, project templates). Extra links,
 * for a task that genuinely spans a deal AND its company, live in
 * `task_links`.
 *
 * Reads union the two. Nothing was copied from the columns into the table, so
 * there is no mirror to drift; the migration argues that case at length.
 *
 * ── AND THE VOCABULARY LIVES HERE ───────────────────────────────────────────
 *
 * The label-and-href chain used to be written out three times, in three files,
 * with three slightly different sets of cases — which is why a company-linked
 * task's chip pointed at a query parameter nobody read. One table now.
 */

export const ENTITY_KINDS = ["lead", "company", "deal", "project", "document"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export function isEntityKind(value: string | null | undefined): value is EntityKind {
  return !!value && (ENTITY_KINDS as readonly string[]).includes(value);
}

/** What to call this kind of thing in a sentence a person reads. */
export const ENTITY_NOUN: Record<EntityKind, string> = {
  lead: "lead",
  company: "company",
  deal: "deal",
  project: "project",
  document: "document",
};

/**
 * Where clicking the chip should land, with the entity opened.
 *
 * `from` is the href to come back to. The surfaces that read it put a "back
 * to…" control on the page, so following a task out of a lead and returning
 * lands where you left rather than at the top of a list.
 */
export function entityHref(
  kind: EntityKind,
  id: string,
  from?: string | null,
): string {
  const base =
    kind === "lead"
      ? `/leads?lead=${id}`
      : kind === "company"
        ? `/leads?company=${id}`
        : kind === "deal"
          ? `/deals?deal=${id}`
          : kind === "project"
            ? `/projects?project=${id}`
            : `/documents?doc=${id}`;
  return from ? `${base}&from=${encodeURIComponent(from)}` : base;
}

/** Where a task itself lives, carrying the way back. */
export function taskHref(
  task: { id: string; boardId: string | null },
  from?: string | null,
): string {
  /**
   * A loose task — a follow-up raised from a lead, a signal's suggested call —
   * has no board and never had one, so it opens in My Work, which is a view of
   * the tasks page (`v=mine`) rather than a route of its own.
   */
  const base = task.boardId
    ? `/tasks?board=${task.boardId}&task=${task.id}`
    : `/tasks?v=mine&task=${task.id}`;
  return from ? `${base}&from=${encodeURIComponent(from)}` : base;
}

export interface EntityRef {
  kind: EntityKind;
  id: string;
  /** True for the one in the task's own columns — the fast path. */
  primary: boolean;
}

/**
 * Every entity a task is about, fast path first.
 *
 * Takes the rows rather than fetching them, so a list of tasks costs one query
 * for all their links instead of one each.
 */
export function refsForTask(
  task: { id: string; entityType: string | null; entityId: string | null },
  links: { taskId: string; entityType: string; entityId: string }[],
): EntityRef[] {
  const out: EntityRef[] = [];
  if (isEntityKind(task.entityType) && task.entityId) {
    out.push({ kind: task.entityType, id: task.entityId, primary: true });
  }
  for (const link of links) {
    if (link.taskId !== task.id) continue;
    if (!isEntityKind(link.entityType)) continue;
    // The fast path may also be in here if somebody linked it twice; show it
    // once, as the primary, because that is the one the columns enforce.
    if (out.some((r) => r.kind === link.entityType && r.id === link.entityId)) continue;
    out.push({ kind: link.entityType, id: link.entityId, primary: false });
  }
  return out;
}

/**
 * The chip a task card shows for what it is about.
 *
 * Takes the already-resolved label maps, so a list of cards costs one query
 * per entity kind rather than one per card. A kind with no label map — a
 * document, a project — gets its noun, which is still a better chip than a
 * blank space, and the href still opens the thing.
 */
export function chipFor(
  task: { entityType: string | null; entityId: string | null },
  labels: Partial<Record<EntityKind, Map<string, string>>>,
): { label: string | null; href: string | null } {
  if (!isEntityKind(task.entityType) || !task.entityId) return { label: null, href: null };
  const kind = task.entityType;
  return {
    label: labels[kind]?.get(task.entityId) ?? ENTITY_NOUN[kind],
    href: entityHref(kind, task.entityId),
  };
}
