/**
 * Model routing (spec §5). Sonnet for writing-quality tasks, Haiku for
 * classification/summaries — "Claude is frugal" (CLAUDE.md hard rule #3).
 * Model IDs verified against the Anthropic model catalog.
 */
export type ModelId = "claude-sonnet-4-6" | "claude-haiku-4-5";

export type UseCase =
  | "lead_research" // Sonnet — research card
  | "outreach_draft" // Sonnet — message draft / critique
  | "reply_analysis" // Haiku  — inbox reply intent/objection
  | "prospect_classify" // Haiku  — Prospector batch classify
  | "audit_summary" // Haiku  — audit pitch summary
  | "meeting_brief" // Sonnet — meeting brief
  | "signal_engine" // Sonnet — weekly analysis
  | "campaign_frame" // Sonnet — cold-email frame drafted ONCE per campaign
  | "daily_insight" // Haiku  — daily insight
  | "winloss_digest" // Haiku  — quarterly win/loss digest (aggregates only)
  | "weekly_report" // Haiku  — Friday report "what worked" commentary
  | "monday_digest" // Haiku  — per-user Monday digest intro (aggregates only)
  | "content_draft" // Haiku  — company-page post (NOT Sonnet: rule #3 lists
  //                                the four Sonnet use cases and this is not one)
  | "doc_scope" // Haiku  — document scope paragraph
  | "person_brief" // Haiku  — 2-3 sentence factual summary on extension capture (P1/1e)
  | "site_lookup" // Haiku  — find a company's own website (web search, on click)
  | "meeting_followup" // Sonnet — the email after a meeting (P13/2)
  | "sector_report" // Sonnet — the prose between a report's numbers (P12/2)
  | "outbound_draft"; // Sonnet — outbound-motor draft or follow-up, per candidate (v6 F4)

export const USE_CASE_MODEL: Record<UseCase, ModelId> = {
  lead_research: "claude-sonnet-4-6",
  outreach_draft: "claude-sonnet-4-6",
  reply_analysis: "claude-haiku-4-5",
  prospect_classify: "claude-haiku-4-5",
  audit_summary: "claude-haiku-4-5",
  meeting_brief: "claude-sonnet-4-6",
  signal_engine: "claude-sonnet-4-6",
  campaign_frame: "claude-sonnet-4-6",
  daily_insight: "claude-haiku-4-5",
  winloss_digest: "claude-haiku-4-5",
  weekly_report: "claude-haiku-4-5",
  monday_digest: "claude-haiku-4-5",
  content_draft: "claude-haiku-4-5",
  doc_scope: "claude-haiku-4-5",
  person_brief: "claude-haiku-4-5",
  // Finding a URL is a lookup, not writing: rule #3 names the four Sonnet use
  // cases and this is not one of them.
  site_lookup: "claude-haiku-4-5",
  // Sonnet: rule #3 names outreach drafting as a writing-quality use case, and
  // this is the first message after a conversation — where a wrong register
  // costs the deal.
  meeting_followup: "claude-sonnet-4-6",
  // Sonnet: this is published writing that carries the company's name in
  // public. One call per report, Owner-triggered and Owner-edited.
  sector_report: "claude-sonnet-4-6",
  // Sonnet: an outreach draft is a writing-quality use case under rule #3,
  // and it only runs for a candidate that passed every deterministic step.
  outbound_draft: "claude-sonnet-4-6",
};

export function modelForUseCase(useCase: UseCase): ModelId {
  return USE_CASE_MODEL[useCase];
}

// Non-streaming defaults kept modest for frugality; override per call.
export const DEFAULT_MAX_TOKENS: Record<ModelId, number> = {
  "claude-sonnet-4-6": 4096,
  "claude-haiku-4-5": 1024,
};
