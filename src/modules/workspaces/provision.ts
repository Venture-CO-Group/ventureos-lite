import type { PrismaClient } from "@prisma/client";
import { BASE_TEMPLATES } from "../templates/seed-data";
import { extractVariables } from "../templates/render";
import { DEFAULT_PIPELINES } from "../deals/pipelines";

/**
 * Everything a workspace needs before anybody can work in it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `prisma/seed.ts` built all of this for the FIRST workspace, and
 * `createWorkspace` — the Owner-facing "New workspace" form — built none of it.
 * A workspace provisioned through the product came out as a bare row: no deal
 * pipelines, so the Deals board had no columns to drop anything into; no
 * templates, so a quote could not be rendered; no ICP config, so the score gate
 * had no threshold; no targets, so the dashboard measured against nothing.
 *
 * Nothing crashed, which is why it survived. Every page returned 200 and simply
 * showed an empty state, so switching into a new workspace looked less like a
 * broken feature than like a product that had forgotten your data — and the
 * reasonable conclusion from the outside is "workspace switching does not
 * work".
 *
 * So the scaffolding lives here, once, and both callers use it. The seed script
 * and the Owner's form now provision identically, which also means the thing
 * being demonstrated in development is the thing customers get.
 *
 * ── IDEMPOTENT ON PURPOSE ───────────────────────────────────────────────────
 *
 * Every step checks before it writes. That lets this double as a REPAIR for
 * workspaces created before this existed — running it again adds only what is
 * missing and never overwrites a pipeline somebody has since tuned.
 */

/** Five one-point criteria and a gate of 3 (spec §4.5). */
export const DEFAULT_ICP_CONFIG = {
  gateThreshold: 3,
  criteria: [
    { key: "segment_fit", label: "Segment fit", weight: 1 },
    { key: "trigger_signal", label: "Trigger signal", weight: 1 },
    { key: "decision_maker", label: "Decision-maker", weight: 1 },
    { key: "active_profile", label: "Active profile", weight: 1 },
    { key: "personal_hook", label: "Personal hook", weight: 1 },
  ],
};

/** The dashboard's default goals, from the prototype. */
export const DEFAULT_TARGETS = [
  { metric: "invites_sent", period: "weekly", value: 100 },
  { metric: "acceptance_rate", period: "weekly", value: 35 },
  { metric: "reply_rate", period: "weekly", value: 20 },
  { metric: "meetings_booked", period: "monthly", value: 10 },
];

export interface ProvisionResult {
  pipelines: number;
  templates: number;
  targets: number;
  icpConfig: boolean;
}

/**
 * Fill in whatever this workspace is missing.
 *
 * Takes a client rather than reaching for one so the seed script (a plain
 * `PrismaClient`) and the server action (the guarded client, already scoped to
 * this workspace) can share it. Writes are addressed by `workspaceId`
 * explicitly in either case, so the guard has nothing to disagree with.
 */
export async function provisionWorkspace(
  prisma: Pick<PrismaClient, "workspace" | "target" | "pipeline" | "template">,
  workspaceId: string,
): Promise<ProvisionResult> {
  const result: ProvisionResult = { pipelines: 0, templates: 0, targets: 0, icpConfig: false };

  // ---- ICP config -------------------------------------------------------
  // The score gate (hard rule #5) reads its threshold from here. Without it a
  // workspace has no defensible answer to "may this lead be contacted".
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { icpConfig: true },
  });
  if (!ws?.icpConfig) {
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { icpConfig: DEFAULT_ICP_CONFIG },
    });
    result.icpConfig = true;
  }

  // ---- targets ----------------------------------------------------------
  for (const t of DEFAULT_TARGETS) {
    const exists = await prisma.target.findFirst({
      where: { workspaceId, metric: t.metric, period: t.period },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.target.create({ data: { workspaceId, ...t } });
    result.targets += 1;
  }

  // ---- deal pipelines ---------------------------------------------------
  // Additive: an existing pipeline keeps whatever the workspace has tuned.
  for (const p of DEFAULT_PIPELINES) {
    const exists = await prisma.pipeline.findFirst({
      where: { workspaceId, key: p.key },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.pipeline.create({
      data: {
        workspaceId,
        key: p.key,
        name: p.name,
        position: p.position,
        isDefault: p.isDefault,
        stages: {
          create: p.stages.map((s, i) => ({
            workspaceId,
            key: s.key,
            name: s.name,
            position: i,
            probability: s.probability,
            rottingDays: s.rottingDays,
            kind: s.kind,
          })),
        },
      },
    });
    result.pipelines += 1;
  }

  // ---- base templates ---------------------------------------------------
  // Quote / contract / certificate / email bodies, HU + EN. Legal documents
  // render from these and only these (hard rule #4), so a workspace without
  // them cannot produce a document at all.
  for (const t of BASE_TEMPLATES) {
    const exists = await prisma.template.findFirst({
      where: { workspaceId, type: t.type, lang: t.lang },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.template.create({
      data: {
        workspaceId,
        type: t.type,
        lang: t.lang,
        name: t.name,
        body: t.body,
        variables: extractVariables(t.body),
        version: 1,
        status: "ACTIVE",
      },
    });
    result.templates += 1;
  }

  return result;
}
