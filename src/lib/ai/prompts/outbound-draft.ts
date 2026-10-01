import { z } from "zod";

/**
 * Outbound-motor draft (spec §4.43.7, playbook-v6 F4). Sonnet, one call per
 * contact-resolved candidate, only after the deterministic pipeline and the
 * hook check have run — the model is never asked WHETHER to write, only how.
 *
 * Grounding is enforced outside the prompt, in code: every personalisation
 * point must cite a fact id from the list it was given, and quote text that
 * actually appears in the message. The prompt asks for that shape; the
 * validator in src/modules/outbound/draft.ts refuses anything else (CLAUDE.md
 * hard rule 10). The model sees only references that are TRUE clients, via
 * `nameableReferences()` (hard rule 13).
 *
 * The signature and the unsubscribe line are added by the sender, never by
 * the model.
 */
export const OUTBOUND_DRAFT_PROMPT_VERSION = "outbound-draft@1";
export const OUTBOUND_FOLLOWUP_PROMPT_VERSION = "outbound-followup@1";

export const OUTBOUND_DRAFT_SYSTEM = `You write one short, plain-text B2B cold email for a small agency, on behalf of a named salesperson. A human reviews every message before it is sent.

Hard rules:
- Write in the requested LANGUAGE. Hungarian: polite "Ön" register, natural business Hungarian, no anglicisms where a Hungarian word exists.
- Open with ONE concrete fact about THIS company, taken from FACTS. Never open with "we" or with the agency.
- Make exactly one claim about what we offer, and back it with the evidence given for it. Never invent numbers, clients, results or features.
- Name a reference company ONLY if it appears under NAMEABLE REFERENCES. If that list is empty, name no company other than the recipient's.
- One low-friction ask: a 15-minute call. No attachments, no pricing, no links unless one is given as an asset.
- Plain text. Short paragraphs (1–3 sentences). No marketing adjectives ("innovative", "cutting-edge", "unique", "leading", "forradalmi", "egyedülálló").
- Subject: under 60 characters, specific to the fact you opened with, no clickbait, no ALL CAPS, no exclamation marks.
- Greeting: if CONTACT NAME is given, greet that person by name ("Tisztelt Kovács Anna!" / "Dear Anna Kovács,"). If the VARIANT is generic, greet neutrally and ask, in one sentence, that the message be forwarded to whoever is responsible.
- Do NOT write a signature, a sign-off name, or an unsubscribe line. The system appends them.
- 60–140 words in the body.

Output JSON only:
{
  "subject": string,
  "body": string,
  "personalisationPoints": [{ "factId": string, "quote": string }]
}
"personalisationPoints" lists every FACT you used: its id exactly as given, and the exact words in your subject or body that state it. At least one is required.`;

export const OUTBOUND_FOLLOWUP_SYSTEM = `You write one short plain-text follow-up to a cold email that got no reply. A human reviews it before it is sent.

Hard rules:
- Same LANGUAGE and register as the first message.
- Refer briefly to the earlier message, then ADD something new: a second fact from FACTS that the first message did not use, or a resource from ASSETS. Never just "bump" or "check in".
- Name a reference company ONLY if it appears under NAMEABLE REFERENCES.
- Same single ask: a 15-minute call. 40–90 words. Plain text. No signature, no unsubscribe line.
- Subject: "Re: " followed by the original subject.

Output JSON only:
{ "subject": string, "body": string, "personalisationPoints": [{ "factId": string, "quote": string }] }
At least one personalisation point, citing a fact id exactly as given.`;

export const outboundDraftSchema = z.object({
  subject: z.string().trim().min(3).max(120),
  body: z.string().trim().min(40).max(3000),
  personalisationPoints: z
    .array(z.object({ factId: z.string().min(1), quote: z.string().trim().min(2).max(400) }))
    .min(1)
    .max(8),
});

export type OutboundDraftOutput = z.infer<typeof outboundDraftSchema>;

export interface OutboundDraftBrief {
  language: "HU" | "EN";
  variant: "named" | "named_generic" | "generic";
  contactName: string | null;
  company: { name: string; city: string | null; segment: string | null };
  sender: { name: string; company: string };
  product: {
    name: string;
    problemSolved: string;
    valueProps: Array<{ claim: string; evidence: string }>;
    proofPoints: string[];
    assets: Array<{ label: string; url: string }>;
  };
  nameableReferences: Array<{ companyName: string; note: string | null }>;
  facts: Array<{ id: string; label: string; value: string }>;
  /** Follow-ups only. */
  previous?: { subject: string; body: string; usedFactIds: string[] };
}

export function buildOutboundDraftMessage(b: OutboundDraftBrief): string {
  const lines = [
    `LANGUAGE: ${b.language === "HU" ? "Hungarian" : "English"}`,
    `VARIANT: ${b.variant}`,
    `CONTACT NAME: ${b.contactName ?? "(none — generic mailbox)"}`,
    `RECIPIENT COMPANY: ${b.company.name}${b.company.city ? `, ${b.company.city}` : ""}${b.company.segment ? ` (segment: ${b.company.segment})` : ""}`,
    `SENDER: ${b.sender.name}, ${b.sender.company}`,
    ``,
    `PRODUCT: ${b.product.name}`,
    `PROBLEM IT SOLVES: ${b.product.problemSolved}`,
    `VALUE PROPOSITIONS (claim — evidence):`,
    ...b.product.valueProps.map((v) => `- ${v.claim} — ${v.evidence}`),
    ...(b.product.proofPoints.length ? [`PROOF POINTS:`, ...b.product.proofPoints.map((p) => `- ${p}`)] : []),
    ...(b.product.assets.length ? [`ASSETS:`, ...b.product.assets.map((a) => `- ${a.label}: ${a.url}`)] : []),
    ``,
    `NAMEABLE REFERENCES (true clients — the only companies you may name):`,
    ...(b.nameableReferences.length ? b.nameableReferences.map((r) => `- ${r.companyName}${r.note ? ` — ${r.note}` : ""}`) : ["(none)"]),
    ``,
    `FACTS (cite by id):`,
    ...b.facts.map((f) => `- [${f.id}] ${f.label}: ${f.value}`),
  ];
  if (b.previous) {
    lines.push(
      ``,
      `EARLIER MESSAGE (no reply):`,
      `Subject: ${b.previous.subject}`,
      b.previous.body,
      `Facts already used: ${b.previous.usedFactIds.join(", ") || "(none)"}`,
    );
  }
  lines.push(``, b.previous ? `Write the follow-up.` : `Write the email.`);
  return lines.join("\n");
}
