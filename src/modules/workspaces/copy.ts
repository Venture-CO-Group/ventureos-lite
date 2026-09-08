import type { Prisma } from "@prisma/client";
import { prismaUnsafe } from "@/lib/db";
import { COPY_GROUP_KEYS } from "./copy-plan";

/**
 * Copying settings from one workspace into another (P6/6.1).
 *
 * ── THE RULE THIS FILE IS BUILT AROUND ──────────────────────────────────────
 *
 * Only what `copy-plan.ts` names, and only configuration. A workspace holds
 * leads, documents, invoices and audit logs — other people's personal data —
 * and moving any of it across a tenancy boundary is the exact thing the guard
 * exists to prevent. So there is no generic "copy the workspace" path here, and
 * every function below is written against one named group.
 *
 * ── WHY prismaUnsafe ────────────────────────────────────────────────────────
 *
 * This reads from workspace A and writes to workspace B, which no guarded
 * client can do by construction — the guard scopes every query to one
 * workspace, correctly. So the caller must have proved the user OWNS both, and
 * every statement here names its workspace explicitly. That check lives in the
 * action, and it is the only reason this is allowed to exist.
 *
 * ── ADDITIVE, NEVER DESTRUCTIVE ─────────────────────────────────────────────
 *
 * Nothing is deleted from the target. A pipeline, template or field that
 * already exists there is left exactly as it is and skipped. That makes the
 * copy safe to run against a workspace somebody has already started using, and
 * safe to run twice.
 */

export interface CopyResult {
  counts: Record<string, number>;
  skipped: string[];
}

export async function copyWorkspaceSettings(
  sourceId: string,
  targetId: string,
  groups: readonly string[],
): Promise<CopyResult> {
  const counts: Record<string, number> = {};
  const skipped: string[] = [];
  // Belt and braces: an unnamed group cannot be smuggled past the action.
  const wanted = groups.filter((g) => COPY_GROUP_KEYS.includes(g));
  if (sourceId === targetId) return { counts, skipped: ["A forrás és a cél ugyanaz."] };

  const source = await prismaUnsafe.workspace.findUnique({
    where: { id: sourceId },
    select: {
      legalName: true,
      brand: true,
      icpConfig: true,
      auditConfig: true,
      featureFlags: true,
    },
  });
  const target = await prismaUnsafe.workspace.findUnique({
    where: { id: targetId },
    select: { featureFlags: true },
  });
  if (!source || !target) return { counts, skipped: ["A munkaterület nem található."] };

  const srcFlags = asObject(source.featureFlags);
  const tgtFlags = asObject(target.featureFlags);
  /** Accumulated feature-flag writes, applied in ONE update at the end. */
  const flagPatch: Record<string, unknown> = {};

  // ---- brand ------------------------------------------------------------
  if (wanted.includes("brand")) {
    await prismaUnsafe.workspace.update({
      where: { id: targetId },
      data: {
        brand: (source.brand ?? {}) as Prisma.InputJsonValue,
        // The legal name comes along because it is what the letterhead prints,
        // and an Owner copying a brand almost always wants the same entity.
        // Easy to change afterwards, unlike noticing it was missing on a
        // contract.
        legalName: source.legalName,
      },
    });
    counts.brand = 1;
  }

  // ---- custom fields ----------------------------------------------------
  if (wanted.includes("fields")) {
    const defs = await prismaUnsafe.customFieldDef.findMany({
      where: { workspaceId: sourceId, archived: false },
      orderBy: { position: "asc" },
    });
    const existing = await prismaUnsafe.customFieldDef.findMany({
      where: { workspaceId: targetId },
      select: { entity: true, key: true },
    });
    const have = new Set(existing.map((d) => `${d.entity}:${d.key}`));
    let n = 0;
    for (const d of defs) {
      if (have.has(`${d.entity}:${d.key}`)) continue;
      await prismaUnsafe.customFieldDef.create({
        data: {
          workspaceId: targetId,
          entity: d.entity,
          // The key never changes — it is the key inside `customFields`, and
          // renaming it would orphan every value in the source too.
          key: d.key,
          label: d.label,
          type: d.type,
          options: d.options as Prisma.InputJsonValue,
          required: d.required,
          position: d.position,
          help: d.help,
        },
      });
      n += 1;
    }
    counts.fields = n;
  }

  // ---- pipelines and stages --------------------------------------------
  if (wanted.includes("pipelines")) {
    const pipelines = await prismaUnsafe.pipeline.findMany({
      where: { workspaceId: sourceId, archived: false },
      include: { stages: { orderBy: { position: "asc" } } },
      orderBy: { position: "asc" },
    });
    const existing = await prismaUnsafe.pipeline.findMany({
      where: { workspaceId: targetId },
      select: { key: true },
    });
    // Matched on the KEY, not the name: `@@unique([workspaceId, key])` is what
    // the database enforces, and a create that collides there throws rather
    // than skipping politely.
    const have = new Set(existing.map((p) => p.key));
    let n = 0;
    for (const p of pipelines) {
      if (have.has(p.key)) continue;
      await prismaUnsafe.pipeline.create({
        data: {
          workspaceId: targetId,
          name: p.name,
          key: p.key,
          position: p.position,
          isDefault: p.isDefault,
          stages: {
            create: p.stages.map((s) => ({
              workspaceId: targetId,
              name: s.name,
              // The key travels, not just the label: it is what a workflow
              // rule's `toStage` matches on, and a renamed key would silently
              // stop every copied rule from firing.
              key: s.key,
              kind: s.kind,
              position: s.position,
              probability: s.probability,
              rottingDays: s.rottingDays,
            })),
          },
        },
      });
      n += 1;
    }
    counts.pipelines = n;
  }

  // ---- document templates ----------------------------------------------
  if (wanted.includes("documentTemplates")) {
    const templates = await prismaUnsafe.template.findMany({
      where: { workspaceId: sourceId, status: { not: "ARCHIVED" } },
    });
    const existing = await prismaUnsafe.template.findMany({
      where: { workspaceId: targetId },
      select: { type: true, lang: true, name: true },
    });
    const have = new Set(existing.map((t) => `${t.type}:${t.lang}:${t.name}`));
    let n = 0;
    for (const t of templates) {
      if (have.has(`${t.type}:${t.lang}:${t.name}`)) continue;
      await prismaUnsafe.template.create({
        data: {
          workspaceId: targetId,
          type: t.type,
          lang: t.lang,
          name: t.name,
          body: t.body,
          variables: t.variables as Prisma.InputJsonValue,
          // Version restarts at 1: the target's template has no history in this
          // workspace, and inheriting "version 7" would make the audit trail
          // claim six edits nobody made here.
          version: 1,
          status: t.status,
        },
      });
      n += 1;
    }
    counts.documentTemplates = n;
  }

  // ---- project templates -----------------------------------------------
  if (wanted.includes("projectTemplates")) {
    const templates = await prismaUnsafe.projectTemplate.findMany({
      where: { workspaceId: sourceId, status: "active" },
    });
    const existing = await prismaUnsafe.projectTemplate.findMany({
      where: { workspaceId: targetId },
      select: { name: true },
    });
    const have = new Set(existing.map((t) => t.name));
    let n = 0;
    for (const t of templates) {
      if (have.has(t.name)) continue;
      await prismaUnsafe.projectTemplate.create({
        data: {
          workspaceId: targetId,
          name: t.name,
          milestones: t.milestones as Prisma.InputJsonValue,
          status: "active",
          version: 1,
        },
      });
      n += 1;
    }
    counts.projectTemplates = n;
  }

  // ---- workflow rules ---------------------------------------------------
  if (wanted.includes("workflows")) {
    const rules = await prismaUnsafe.workflowRule.findMany({
      where: { workspaceId: sourceId },
    });
    const existing = await prismaUnsafe.workflowRule.findMany({
      where: { workspaceId: targetId },
      select: { name: true },
    });
    const have = new Set(existing.map((r) => r.name));
    let n = 0;
    for (const r of rules) {
      if (have.has(r.name)) continue;
      await prismaUnsafe.workflowRule.create({
        data: {
          workspaceId: targetId,
          name: r.name,
          trigger: r.trigger,
          triggerConfig: r.triggerConfig as Prisma.InputJsonValue,
          conditions: r.conditions as Prisma.InputJsonValue,
          actions: r.actions as Prisma.InputJsonValue,
          /**
           * Copied SWITCHED OFF, always.
           *
           * A rule can create tasks, move stages and draft messages. Arriving
           * in a fresh workspace already armed means the first lead somebody
           * enters trips automation nobody has read yet — and the conditions
           * may reference custom fields that did not come along.
           */
          enabled: false,
          version: 1,
        },
      });
      n += 1;
    }
    counts.workflows = n;
    if (n > 0) skipped.push(`${n} workflow szabály kikapcsolva jött át — nézd át, majd élesítsd.`);
  }

  // ---- quote rules (feature flags) --------------------------------------
  if (wanted.includes("quoteRules") && srcFlags.quoteRules !== undefined) {
    flagPatch.quoteRules = srcFlags.quoteRules;
    counts.quoteRules = 1;
  }

  // ---- scoring: ICP config, gate, audit weights -------------------------
  if (wanted.includes("scoring")) {
    await prismaUnsafe.workspace.update({
      where: { id: targetId },
      data: {
        icpConfig: (source.icpConfig ?? {}) as Prisma.InputJsonValue,
        auditConfig: (source.auditConfig ?? {}) as Prisma.InputJsonValue,
      },
    });
    if (srcFlags.clientHealth !== undefined) flagPatch.clientHealth = srcFlags.clientHealth;
    counts.scoring = 1;
  }

  // ---- targets ----------------------------------------------------------
  if (wanted.includes("targets")) {
    const targets = await prismaUnsafe.target.findMany({ where: { workspaceId: sourceId } });
    const existing = await prismaUnsafe.target.findMany({
      where: { workspaceId: targetId },
      select: { metric: true, period: true },
    });
    const have = new Set(existing.map((t) => `${t.metric}:${t.period}`));
    let n = 0;
    for (const t of targets) {
      if (have.has(`${t.metric}:${t.period}`)) continue;
      await prismaUnsafe.target.create({
        data: {
          workspaceId: targetId,
          metric: t.metric,
          period: t.period,
          value: t.value,
        },
      });
      n += 1;
    }
    counts.targets = n;
  }

  // ---- hidden navigation ------------------------------------------------
  if (wanted.includes("navigation") && Array.isArray(srcFlags.hiddenNav)) {
    flagPatch.hiddenNav = srcFlags.hiddenNav;
    counts.navigation = (srcFlags.hiddenNav as unknown[]).length;
  }

  /**
   * One write for every flag change.
   *
   * `featureFlags` is a single JSON column shared by retention, the cold-email
   * domain, hidden navigation, the 2FA policy, quote rules and audit-log
   * retention. Two updates in a row would each read a stale copy and the second
   * would erase the first. So the patch is merged onto the TARGET's own flags —
   * never onto the source's — and applied once.
   */
  if (Object.keys(flagPatch).length > 0) {
    await prismaUnsafe.workspace.update({
      where: { id: targetId },
      data: { featureFlags: { ...tgtFlags, ...flagPatch } as Prisma.InputJsonValue },
    });
  }

  return { counts, skipped };
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
