/**
 * Turning a contact-resolved candidate into a draft in the approval queue
 * (playbook-v6 F4/1). Called by a sourcing run, and for follow-ups by the
 * send scheduler (F5).
 *
 * The order is the frugality rule (CLAUDE.md hard rule 3) made concrete:
 * the deterministic hook check runs FIRST, and a candidate with nothing
 * company-specific to say never costs a Claude call. Every call goes through
 * `callClaude`, which enforces the daily budget and logs to ClaudeUsage.
 */
import type { Prisma } from "@prisma/client";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { callClaude, type CallClaudeParams, type CallClaudeResult } from "@/lib/ai/call-claude";
import { BudgetExceededError } from "@/lib/ai/budget";
import {
  OUTBOUND_DRAFT_PROMPT_VERSION,
  OUTBOUND_DRAFT_SYSTEM,
  OUTBOUND_FOLLOWUP_PROMPT_VERSION,
  OUTBOUND_FOLLOWUP_SYSTEM,
  buildOutboundDraftMessage,
  outboundDraftSchema,
  type OutboundDraftOutput,
} from "@/lib/ai/prompts/outbound-draft";
import { brandFrom } from "@/modules/workspaces/brand";
import { toProductView } from "./catalog";
import { nameableReferences } from "./references";
import { hasHook, type CandidateFact } from "./facts";
import { validateDraft, type PersonalisationPoint } from "./draft";
import { transition } from "./state";
import { COLD_OUTBOUND_ADDRESS } from "./config";
import type { ResolvedContact } from "./contact";

export interface DraftDeps {
  claude?: (p: CallClaudeParams<OutboundDraftOutput>) => Promise<CallClaudeResult<OutboundDraftOutput>>;
  now?: () => Date;
}

export type DraftOutcome = "drafted" | "no_hook" | "budget" | "skipped" | "error";

function factsOf(raw: unknown): CandidateFact[] {
  return Array.isArray(raw) ? (raw as CandidateFact[]) : [];
}

async function senderName(workspaceId: string): Promise<string> {
  const account = await prismaUnsafe.mailAccount.findFirst({
    where: { workspaceId, accountEmail: COLD_OUTBOUND_ADDRESS },
    select: { userId: true },
  });
  const user = account ? await prismaUnsafe.user.findUnique({ where: { id: account.userId }, select: { name: true } }) : null;
  return user?.name ?? "";
}

/**
 * Generate, validate and queue. One repair attempt with the validator's
 * reason fed back; a draft that still cannot be grounded leaves as NO_HOOK.
 */
export async function draftCandidate(workspaceId: string, candidateId: string, deps: DraftDeps = {}): Promise<DraftOutcome> {
  const db = getWorkspaceClient(workspaceId);
  const now = deps.now ?? (() => new Date());
  const claude = deps.claude ?? ((p) => callClaude<OutboundDraftOutput>(p));
  const c = await db.prospectCandidate.findUnique({ where: { id: candidateId } });
  if (!c || c.state !== "CONTACT_RESOLVED") return "skipped";

  const facts = factsOf(c.facts);
  // The hook gate, before any money is spent.
  if (!hasHook(facts)) {
    await transition(db, workspaceId, c, "FILTERED_OUT", {
      reason: "NO_HOOK",
      detail: "no audit finding, missing website or registry figure to build the message on",
      at: now(),
    });
    return "no_hook";
  }

  const product = c.productId
    ? await db.product.findUnique({ where: { id: c.productId }, include: { references: true, profiles: true } })
    : null;
  if (!product) {
    await db.prospectCandidate.update({ where: { id: c.id }, data: { lastError: "the product no longer exists" } });
    return "error";
  }
  const view = toProductView(product);
  const contact = (c.contact ?? null) as ResolvedContact | null;
  if (!contact?.email) return "skipped";
  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { brand: true } });
  const brand = brandFrom(ws?.brand);
  const variant = contact.kind === "named" ? "named" : contact.kind === "named_generic" ? "named_generic" : "generic";

  const brief = {
    language: view.language,
    variant,
    contactName: variant === "generic" ? null : contact.name,
    company: { name: c.name, city: facts.find((f) => f.id === "registry:seat")?.value ?? null, segment: c.matchedSegment },
    sender: { name: (await senderName(workspaceId)) || brand.name, company: brand.name },
    product: {
      name: view.name,
      problemSolved: view.problemSolved,
      valueProps: view.valueProps,
      proofPoints: view.proofPoints,
      assets: view.assets,
    },
    // The ONLY references the model sees. A pattern reference cannot reach
    // the prompt: the type of this field is what `nameableReferences` returns.
    nameableReferences: nameableReferences(view.references).map((r) => ({ companyName: r.companyName, note: r.note })),
    facts: facts.map((f) => ({ id: f.id, label: f.label, value: f.value })),
  } as const;

  let output: OutboundDraftOutput | null = null;
  let lastProblem = "";
  let cost = 0;
  const message = buildOutboundDraftMessage({ ...brief, nameableReferences: [...brief.nameableReferences], facts: [...brief.facts] });
  try {
    for (let attempt = 0; attempt < 2 && !output; attempt++) {
      const res = await claude({
        useCase: "outbound_draft",
        workspaceId,
        system: OUTBOUND_DRAFT_SYSTEM,
        messages: [
          {
            role: "user",
            content:
              attempt === 0
                ? message
                : `${message}\n\nYour previous draft was refused: ${lastProblem}. Fix exactly that and return the JSON again.`,
          },
        ],
        schema: outboundDraftSchema,
        maxTokens: 900,
      });
      cost += res.costUsd;
      const draft = res.data as OutboundDraftOutput;
      const check = validateDraft(draft, facts, view.references);
      if (check.ok) output = draft;
      else lastProblem = check.error;
    }
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      // Wait for tomorrow's budget; the candidate stays where it is.
      await db.prospectCandidate.update({ where: { id: c.id }, data: { lastError: "Claude daily budget reached — drafting resumes tomorrow" } });
      return "budget";
    }
    await db.prospectCandidate.update({ where: { id: c.id }, data: { lastError: (e as Error).message.slice(0, 300) } });
    return "error";
  }

  if (!output) {
    await transition(db, workspaceId, c, "FILTERED_OUT", {
      reason: "NO_HOOK",
      detail: `the draft could not be grounded in this company's facts (${lastProblem})`,
      at: now(),
    });
    return "no_hook";
  }

  await db.outreachDraft.create({
    data: {
      workspaceId,
      candidateId: c.id,
      productId: product.id,
      step: 0,
      variant,
      language: view.language,
      templateVersion: OUTBOUND_DRAFT_PROMPT_VERSION,
      toAddress: contact.email,
      toName: variant === "generic" ? null : contact.name,
      subject: output.subject,
      body: output.body,
      originalSubject: output.subject,
      originalBody: output.body,
      personalisationPoints: output.personalisationPoints as unknown as Prisma.InputJsonValue,
      claudeCostUsd: cost,
    },
  });
  await transition(db, workspaceId, c, "DRAFTED", { detail: OUTBOUND_DRAFT_PROMPT_VERSION, at: now() });
  await transition(db, workspaceId, c, "PENDING_APPROVAL", { at: now() });
  return "drafted";
}

/**
 * A follow-up draft (playbook-v6 F5/4). It must add something — a fact the
 * first message did not use — so a candidate whose facts are spent gets no
 * follow-up rather than a bump. It enters the same approval queue.
 */
export async function draftFollowup(
  workspaceId: string,
  candidateId: string,
  step: 1 | 2,
  scheduledFor: Date,
  deps: DraftDeps = {},
): Promise<DraftOutcome> {
  const db = getWorkspaceClient(workspaceId);
  const claude = deps.claude ?? ((p) => callClaude<OutboundDraftOutput>(p));
  const c = await db.prospectCandidate.findUnique({ where: { id: candidateId } });
  if (!c || c.state !== "SENT") return "skipped";
  const previous = await db.outreachDraft.findMany({ where: { candidateId, status: "SENT" }, orderBy: { step: "asc" } });
  const first = previous[0];
  if (!first || previous.length !== step) return "skipped";
  if (await db.outreachDraft.findUnique({ where: { candidateId_step: { candidateId, step } } })) return "skipped";

  const facts = factsOf(c.facts);
  const used = new Set(previous.flatMap((d) => (Array.isArray(d.personalisationPoints) ? (d.personalisationPoints as unknown as PersonalisationPoint[]).map((p) => p.factId) : [])));
  const fresh = facts.filter((f) => !used.has(f.id));
  const product = c.productId ? await db.product.findUnique({ where: { id: c.productId }, include: { references: true, profiles: true } }) : null;
  if (!product) return "error";
  const view = toProductView(product);
  if (fresh.length === 0 && view.assets.length === 0) return "no_hook";

  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { brand: true } });
  const brand = brandFrom(ws?.brand);
  const last = previous[previous.length - 1]!;
  const message = buildOutboundDraftMessage({
    language: view.language,
    variant: first.variant as "named" | "named_generic" | "generic",
    contactName: first.toName,
    company: { name: c.name, city: null, segment: c.matchedSegment },
    sender: { name: (await senderName(workspaceId)) || brand.name, company: brand.name },
    product: { name: view.name, problemSolved: view.problemSolved, valueProps: view.valueProps, proofPoints: view.proofPoints, assets: view.assets },
    nameableReferences: nameableReferences(view.references).map((r) => ({ companyName: r.companyName, note: r.note })),
    // Fresh facts only, so the follow-up cannot simply repeat the opener.
    facts: (fresh.length ? fresh : facts).map((f) => ({ id: f.id, label: f.label, value: f.value })),
    previous: { subject: last.subject, body: last.body, usedFactIds: [...used] },
  });

  let output: OutboundDraftOutput | null = null;
  let problem = "";
  let cost = 0;
  try {
    for (let attempt = 0; attempt < 2 && !output; attempt++) {
      const res = await claude({
        useCase: "outbound_draft",
        workspaceId,
        system: OUTBOUND_FOLLOWUP_SYSTEM,
        messages: [{ role: "user", content: attempt === 0 ? message : `${message}\n\nRefused: ${problem}. Fix exactly that.` }],
        schema: outboundDraftSchema,
        maxTokens: 700,
      });
      cost += res.costUsd;
      const d = res.data as OutboundDraftOutput;
      const check = validateDraft(d, fresh.length ? fresh : facts, view.references);
      if (check.ok) output = d;
      else problem = check.error;
    }
  } catch (e) {
    if (e instanceof BudgetExceededError) return "budget";
    return "error";
  }
  if (!output) return "no_hook";

  await db.outreachDraft.create({
    data: {
      workspaceId,
      candidateId,
      productId: product.id,
      step,
      variant: first.variant,
      language: view.language,
      templateVersion: OUTBOUND_FOLLOWUP_PROMPT_VERSION,
      toAddress: first.toAddress,
      toName: first.toName,
      subject: output.subject,
      body: output.body,
      originalSubject: output.subject,
      originalBody: output.body,
      personalisationPoints: output.personalisationPoints as unknown as Prisma.InputJsonValue,
      scheduledFor,
      claudeCostUsd: cost,
    },
  });
  return "drafted";
}
