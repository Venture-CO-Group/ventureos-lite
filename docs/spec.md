# Venture OS Lite — Software Specification
### AI-assisted sales & delivery workspace · Venture CO Group · v3.0

---

## 1. Product summary

Venture OS Lite is the single internal workspace for Venture CO Group's business development and sales-document workflow. One surface covers the whole path: **find** businesses (Google prospecting + LinkedIn + manual), **assess** them (website audit, ICP scoring), **reach** them (Claude-assisted outreach, human-sent), **qualify and book** (pipeline, inbox, meetings), and **close the paperwork** (quotes, contracts, completion certificates, sent by email).

**"Lite" means:** this is v1 of a larger platform. The extended feature set (defined separately) will be added later, so the architecture must be modular from day one — module registry, per-workspace feature flags, versioned APIs between modules. Nothing in Lite may assume it is the final shape.

**Design philosophy — human-in-the-loop, credit-frugal.** Claude does the thinking (research, scoring commentary, drafting, analysis); humans do the sending. Deterministic APIs and local checks do everything they can *before* Claude is called (see §6). No message is ever auto-sent to a prospect; transactional document emails (quotes/contracts/certificates) are sent via Mailgun on explicit user action.

**Users:** Fanni (BDR), Tamas (Owner/Admin). **Multi-workspace:** the same instance can host additional companies later (§7).
**Language:** English UI, responsive down to mobile. **Brand:** Venture design system (navy `#00051D`, purple gradient `#310B59 → #7427C6`, white logo, Bricolage Grotesque + Inter) — themable per workspace.

## 2. Goals & non-goals

**Goals**
1. One screen for the entire BDR day; only LinkedIn itself stays external.
2. Three lead sources: Google keyword prospecting, LinkedIn capture, manual entry / CSV.
3. Built-in website auditor that answers "is this business worth contacting for a website project?"
4. Quote → contract → completion certificate generation from editable templates, emailed from the app.
5. Multi-workspace with per-workspace users, roles, and granular permission grants.
6. Claude API cost kept low by design (§6): target <$50/month at full usage.
7. Usable on mobile for on-the-go triage (inbox, pipeline, approvals).

**Non-goals (v1 Lite)**
- No automated sending of outreach messages on LinkedIn or any social channel.
- No e-signature in Lite — deferred deliberately: an **in-house e-signature module is planned**, so the quote-acceptance and contract flows are designed with a signature slot (§4.19) rather than a third-party dependency.
- No client portal (evaluated, rejected).
- Invoice *issuing* stays in Számlázz.hu — Venture OS prepares and hands off (§4.24), it is not an accounting system.
- No public SaaS onboarding, billing, or self-service signup — alternative instances/workspaces are provisioned by the owner.

## 3. Roles & permissions (RBAC + grants)

| Role | Scope |
|---|---|
| **Owner** (Tamas) | Everything across all workspaces: settings, templates, documents, budgets, user management |
| **Admin** | Everything within assigned workspace(s) |
| **BDR** (Fanni) | Leads, prospecting, audits, outreach, inbox, meetings, content, analytics — within assigned workspace(s) |

**Granular grants** on top of roles, assignable per user per workspace: `documents.quote.create`, `documents.contract.create`, `documents.certificate.create`, `documents.send`, `templates.edit`, `signal_engine.approve`, `exports.run`, **`fields.manage`** (v2 — Owner-defined fields), **`data.merge`** (v2 — merging two companies or two leads). **Default: all `documents.*` and `templates.*` grants belong to Owner only; Fanni gets none until explicitly granted.** Every grant change is audit-logged.

**Owner-only actions** that are not grants because they are not delegable in practice: workflow rules (standing permission for the system to act on its own), the forecast's commit threshold, deleting a lead, and rolling an import back — the last two are the same capability wearing two hats, so they answer to the same rule.

## 4. Modules

### 4.1 Dashboard
Today Queue (due follow-ups, replies, briefs, uncontacted researched leads), KPI cards vs. targets, pipeline snapshot, one daily Claude insight, **Claude budget meter** (today's spend vs. cap), pending document approvals (Owner view).

### 4.2 Lead capture — three ways in
1. **LinkedIn capture:** paste URL + page text, or browser-extension grab of the page the user is viewing. Assistive only; no scraping, no sending.
2. **Manual entry:** full lead/company form (name, title, company, contacts, industry, size, notes, signals) — no AI required at any step; Claude research is an optional button afterwards.
3. **CSV import** with column mapping and dedupe preview.
All three converge on the same Lead Card and dedupe check (same person/domain).

### 4.3 Prospector (Google discovery) — NEW
Purpose: "find me plumbers / restaurants / dental clinics in <city> and tell me who has no or a weak website."
- Input: keyword(s) + location + radius; optional filters (rating, review count).
- **Engine: Google Places API (Text Search + Place Details)** — returns business name, address, phone, rating, and crucially the `website` field. This is deterministic and cheap; **Claude is not needed to find businesses.**
- Result list flags: `No website` / `Facebook-only` / `Has website`; one-click actions per row: **Audit site** (→ 4.4) and **Add as lead** (creates Company + unnamed contact to fill in later).
- Optional Claude step (batched, Haiku, one call per ~25 rows, user-triggered): classify segment fit against the ICP and suggest a priority order. Off by default.
- Search runs are saved (keyword, location, date, results) so the same area isn't re-purchased from the Places API; cached 30 days.
- Cost note: Places Text Search ≈ $0.032/request + details lookups; budget cap and per-run estimate shown before executing.

### 4.4 Website Auditor — NEW (core sales tool)
Purpose: decide in 60 seconds whether a business is a website-development prospect, with evidence to quote from.
- Input: URL (from Prospector row, lead record, or manual paste).
- **Deterministic checks (no AI):**
  - HTTPS/SSL validity; mobile viewport tag + responsive heuristics; Google **PageSpeed Insights API** (free) for performance/SEO/accessibility/best-practice scores, Core Web Vitals
  - Meta title/description presence & length; H1 structure; image alt coverage; sitemap.xml & robots.txt; favicon; last copyright year in footer; broken-link sample; cookie-consent banner presence (GDPR signal); tech fingerprint (WordPress version, page builder, framework)
  - Contact conversion basics: phone/email visible, form present, online booking/reservation present
- **Output: Audit Report** — overall opportunity score 0–100, pass/fail check list, screenshots (mobile + desktop via headless render), and **Opportunity flags** ("no mobile layout", "PageSpeed 28", "no online reservation", "copyright 2019") that map directly to Venture's pitch.
- **Optional Claude step (Haiku, 1 short call, cached 30 days per domain):** 3-sentence pitch-angle summary in the lead's language. Toggleable.
- Audit results attach to the lead, auto-populate trigger signals ("outdated website"), and feed the ICP score. Exportable as a **branded PDF one-pager** — usable as a value-first attachment in outreach or meetings.
- Verdict chip: `Strong prospect / Possible / Skip` from rule thresholds (admin-configurable), not AI.
- **Audit share page:** every audit can be published to a unique branded URL (`audit.ventureco.group/<slug>`) — a polished, prospect-facing version of the report. Open events are tracked (first open, count) and land on the lead timeline; the link is the strongest value-first attachment for outreach and cold email. Pages expire (default 60 days) and are unlisted.

#### 4.4b Audit Engine v2 (P2) — capabilities added on top of the above
All of it deterministic: **v2 introduced zero new Claude call sites.** The optional Haiku pitch above remains the module's only AI.

- **Limited multi-page crawl (P2/1).** Internal and sales-PDF only — public and self-serve audits stay single-page for cost control. Up to 15 pages (max 25), robots.txt obeyed, one request per second, 45s crawl deadline. Produces a **Site structure** category: broken internal links with source→target, redirect chains, missing/duplicate titles and meta descriptions, H1 consistency, orphan hints from the sitemap, HTML-weight outliers. The homepage plus the two heaviest pages also get the browser/axe treatment. Structure checks are **unscored on purpose** so a crawled and an uncrawled audit of the same site stay comparable for the delta below.
- **CrUX field data (P2/2).** Origin-level Core Web Vitals from the free Chrome UX Report API, shown beside the PageSpeed lab score on all three surfaces, with a plain-language line. "Not enough traffic" is reported as exactly that. Unscored, since most micro-SMB origins have no coverage. Key falls back to the PageSpeed one.
- **Competitor side-by-side (P2/3).** One or two competitors, picked manually or suggested from the company's Places category and city (cost previewed first). Competitor audits are ordinary cached audits; their companies are stored with `source=competitor_audit`. Internally and in the sales PDF the competitors are named; **the public share page shows only an anonymised average** and never a third party's name or URL.
- **Impact/effort prioritisation (P2/4).** Every check declares impact and effort (Owner-tunable in Settings); findings render as a four-quadrant plan and the sales PDF gains a deterministic "Javasolt sorrend" page. Selected findings map through a per-workspace table (category → service line + HUF band) into a **draft quote** via the existing quote builder — grants, watermark and template pinning unchanged.
- **Re-audit deltas and watches (P2/5).** Any company can be watched at 30/90/180 days; Qualified+ stages turn a watch on automatically. Each re-run stores the delta (score, per category, newly broken and resolved checks) against the previous audit **of the same schema version**. A significant worsening produces a "time to call" signal; a significant improvement produces a competitive-timing one. Settings shows the projected weekly audit load against a configurable watch cap.
- **Full white-label (P2/6).** Every audit surface — internal header, sales PDF, share page, self-serve landing, emailed report — takes its logo, colours, footer identity, sender and slug prefix from `Workspace.brand`, with Venture as the seed. Colours are validated before reaching CSS.
- **Keyword rank tracking (P2/7).** Behind a `SerpProvider` adapter with a **NullProvider default**: dormant until a workspace configures a paid credential. Never scrapes Google. Weekly positions per company (cap 10, projected monthly cost shown before enabling), a "Keresési láthatóság" panel with trends and share-of-top-10, one line in the sales PDF, and a retention signal when a **client's** term drops out of the top ten. No keyword research, no volume data — tracking of known terms only.
- **Log analysis (P2/8).** Internal client-work tool: upload nginx/Apache access logs (gzip accepted, 200 MB cap, streamed in the worker). Reports crawl budget by path with **reverse-DNS-verified** bot identity, status-code breakdown over time, 404/5xx hotspots, redirect hits, bot-only vs human-only paths, and slow endpoints when the format carries timings. Output: internal view + branded PDF appendix. **GDPR: raw uploads are deleted as soon as the aggregate is stored, and in all cases within 7 days** (retention job + test); no log line or IP is ever persisted.
- **JS-framework rendered crawling (P2/9).** The homepage probe detects framework markers and measures how much text is missing without JavaScript. A server-rendered Next/Nuxt site stays on the fast path; a client-rendered SPA switches the crawl to Playwright with a hydration wait and client-side route discovery, capped at 10 pages / 15s per page / 3 minutes total. Emits the "content visible without JavaScript" SEO finding.
- **Schema version 3** stamps every audit, so cached audits keep rendering under the check set they were scored with.

### 4.5 Pipeline
As v1.0: kanban `Researched → Contacted → Accepted → Replied → Qualified → Meeting booked → Handed off` + `Not now` (wake-up default +6 months) + `Disqualified` (reason required). Score gate: <3 cannot enter Contacted. Stage automations are task-level only, never messaging. Mobile: swipeable columns, tap-to-move stage picker.

### 4.6 Outreach Studio
As v1.0: sequence (connection ≤300 chars live counter, FU1, FU2), Claude draft + critique, human-edit guardrail before "Sent", "Copy & open LinkedIn", max 2 follow-ups then auto `Not now`. Audit-report insight lines can be inserted as hooks.

### 4.7 Inbox
As v1.0: threaded replies (pasted/extension-captured), Claude intent & objection analysis, qualification checklist (3 of 4 unlocks Qualified), price-mention auto-escalation to Owner. Mobile-first view (this is the on-the-go module).

### 4.8 Meetings
Booking with Google Calendar, one-click Claude meeting brief (Sonnet), branded PDF export, outcome logging at handoff.

### 4.9 Documents — NEW (Quotes · Contracts · Completion certificates)
The paperwork engine from qualified deal to fulfilled project.
- **Quote generator (árajánlat):** pick client (from pipeline or manual) + template → form with line items; **pricing presets encode house rules** (≈15% commission on venue/catering-type pass-through items, ≈30% markup on production items — editable per line); VAT handling per workspace; validity date; totals computed live. Output: branded PDF.
- **Contract generator (szerződés):** template + variables (parties from company registry data entered manually, scope from the accepted quote, milestones, payment terms). Hungarian and English template sets.
- **Completion certificate generator (teljesítésigazolás):** generated from a contract's scope items; marks deliverables complete, date, acceptance clause; closes the document chain.
- **Document chain & statuses:** Quote `draft → sent → accepted/declined/expired` → Contract `draft → sent → signed (manually marked)` → Certificate `draft → sent → acknowledged`. Each links to the lead and to each other; the pipeline card shows the chain state.
- **Every legal document renders with a "DRAFT" watermark and a footer note recommending legal review** until an Owner explicitly marks it final (watermark removal is an audited action).
- **No Claude in the generation path by default** — templates + variables are deterministic (zero credits, zero hallucination risk in legal text). Optional assist: Claude proposes a scope-description paragraph from the meeting brief; always human-approved.
- **Access:** all generators sit behind `documents.*` grants — Owner-only at launch, grantable to Fanni later without a code change.
- **Quote acceptance page — NEW:** a sent quote optionally publishes to a unique, unlisted URL where the client sees the branded quote and clicks **Accept** (name + company + checkbox + timestamp + IP logged, confirmation email both ways). Acceptance flips the quote to `accepted`, notifies the Owner, and unlocks contract generation pre-filled from the quote. This is *contractual assent evidence, not a qualified e-signature* — the page carries that wording, and the acceptance record is stored immutably. **The in-house e-signature module planned for later plugs into this exact slot**: the Accept step is an interface, its implementation is swappable.

### 4.10 Template Editor — NEW
- Rich-text/markdown editor with variable placeholders (`{{client.name}}`, `{{quote.total_net}}`, `{{items_table}}`, `{{workspace.legal_name}}`…), live preview with sample data, HU/EN variants per template.
- Versioned: documents remember which template version produced them; old documents re-render identically.
- Per-workspace template sets (each company gets its own letterhead, footer, legal blocks); Venture letterhead derived from the existing brand package.
- Guard: variables that would render empty block the "final" state with a clear error.

### 4.11 Email (Mailgun) — NEW
- Transactional sending: quotes, contracts, completion certificates (PDF attached), meeting confirmations, Friday report. Explicit user action every time; **no campaign/bulk sending in Lite.**
- Per-workspace sending identity: verified domain/subdomain (e.g. `mail.ventureco.group`), from-name, reply-to; **Mailgun EU region** for GDPR data residency.
- Email templates (subject + body) live in the same Template Editor; delivery + open tracking logged to the lead timeline; bounce/suppression list respected; failed sends surface in Today Queue.
- BDR can send only document types she has the `documents.send` grant for.

### 4.12 Content Hub
As v1.0: company-page post drafting (Claude, brand voice locked), Draft → In review → Approved → Published board, manual publishing.

### 4.13 Signal Engine
As v1.0: weekly Claude analysis of what converts (frames, hooks, signals, segments), proposals to an approval queue (Owner), versioned frame library, min n=20 before proposing. Runs weekly, not per-event — cheap by design.

### 4.14 Analytics & Reports
Funnel, trends vs. 30/60/90 targets, per-source performance (Prospector vs LinkedIn vs manual), audit-to-meeting conversion, document-chain metrics (quote acceptance rate, avg. days quote→signed), auto Friday report (in-app + Mailgun + branded PDF).

### 4.16 Cold Email — NEW (compliance-gated)
Second outreach channel beside LinkedIn, especially for Prospector-sourced leads.
- Campaigns: audience from a saved segment (e.g. "no-website plumbers, Budapest, audited ≥70"), sequence of 2–3 steps with stop-on-reply, per-lead personalization slots (audit findings, company facts) rendered from data — **Claude drafts the frame once per campaign, not per recipient** (credit rule).
- Sending: Mailgun on the **dedicated cold domain `cold.ventureco.agency`** — fully separated from transactional mail (`mg.ventureco.group`), so a cold-campaign incident cannot affect quote/contract deliverability. Guardrails: warm-up ramp, daily send caps (start 10/day, ramping with domain age), recipient quality gate (audit score ≥ threshold or a verified trigger signal), mandatory unsubscribe + instant suppression, plain-text-first templates, circuit breaker (bounce rate >3% or spam complaint auto-pauses the campaign and notifies the Owner).
- Replies: forwarded into the Inbox module via Mailgun routes → same qualification flow as LinkedIn replies.
- **Compliance gate — hard requirement:** Hungarian law (2008. évi XLVIII. tv.) treats unsolicited electronic advertising strictly, including B2B. The module ships **disabled per workspace** and can only be enabled after counsel sign-off is recorded in Settings (who/when/scope). Practical guardrails built in: company role addresses vs. named personal addresses are distinguished; legitimate-interest documentation fields per campaign; instant-suppress on any objection. *This spec is not legal advice; the gate exists precisely because the legal answer must come first.*

### 4.17 Call Log & Callbacks — NEW
Prospector finds businesses whose owners answer phones, not LinkedIn.
- One-tap call logging on a lead (mobile-first): outcome taxonomy (`no answer / callback requested / interested / not interested / wrong number`), note, duration optional.
- Callback scheduling creates a task that surfaces in Today Queue at the right time (mobile push via PWA notification).
- Calls are first-class activities: they feed the funnel, Signal Engine, and win/loss the same as messages.

### 4.18 Referral Tracking — NEW
- Every lead carries a source (`prospector / linkedin / manual / referral / cold_email`); referral source links to a **Referrer** (person or company, can itself be a client).
- Referrer view: who has sent what, what it converted to, revenue attributed through the chain.
- Weekly digest and analytics surface top referrers — the network is a measurable channel, not folklore.

### 4.19 Company Registry Enrichment & Dedupe — NEW
- Integration with a Hungarian company-data provider (**Opten or Céginformáció API** — select on price at build time): lookup by name or adószám → legal name, tax ID, registration number, headcount band, revenue band, status (active/under proceedings).
- On lead/company creation: automatic candidate match → confirm → enrich; **adószám becomes the dedupe key** (far stronger than name/domain matching).
- Enrichment feeds ICP scoring (size/revenue criteria become factual, not guessed) and pre-fills contract party data — typo-free legal documents.
- Red flags surface automatically: company under liquidation/enforcement → warning chip on the lead and on quote generation.

### 4.20 Win/Loss Analysis — NEW
- Handoff is no longer the end: post-meeting deals get an outcome record — `won / lost / postponed`, reason taxonomy (price, timing, competitor, no budget, no response…), deal value, competitor name optional.
- Win/loss data closes the loop for the Signal Engine: it learns not just what gets replies, but **what closes** — hooks, segments, sources, and audit-score bands ranked by revenue, not by reply rate.
- Quarterly win/loss digest for the Owner.

### 4.21 Booking Page — NEW
- Branded public scheduling page per host (first: Tamas) — `meet.ventureco.group/tamas` — reading free/busy from Google Calendar, offering configured slots, buffers, and meeting types.
- A booking creates the Meeting record, triggers the Claude brief, sends confirmations via Mailgun, and drops the event on both calendars. Replaces Calendly; the link goes into outreach, email signatures, and the quote-acceptance thank-you screen.

### 4.22 Weekly Digest — NEW
- Monday 07:30 Mailgun email to each user, per workspace: this week's Today Queue preview, due callbacks, overdue follow-ups, pipeline deltas, pending approvals (Owner), top referrer note. One Haiku call per digest, aggregates only.

### 4.23 Számlázz.hu Integration — NEW
- From an acknowledged completion certificate: **Prepare invoice** → Venture OS composes the invoice payload (partner data from registry enrichment, line items from the quote/contract chain) and submits via the **Számlázz.hu Számla Agent API**.
- Human confirmation is mandatory before submission (accounting is consequential); the returned invoice number and PDF link attach to the document chain; payment status polls back to the pipeline card.
- Per-workspace Agent key; failures land in Today Queue. Chain complete: *prospect found → audited → contacted → met → quoted → accepted → contracted → certified → invoiced* — one system, end to end.

### 4.25 Deals & Pipelines — v2 (P4)
- **A Lead is a person; a Deal is a piece of work with money attached.** The boundary: a lead owns the pre-deal journey (Researched → Replied), a deal owns everything from Qualified onward. The lead board labels its columns accordingly and links across; a lead that has crossed over wears a deal chip.
- **Pipelines and stages are data, per workspace.** Seeded with *Web projects* (default) and *Grants*, which exist because they close on different clocks — an application sits with the awarding body for weeks and is not rotting while it does. Each stage carries a default probability, a rotting threshold and a kind (`open` / `won` / `lost`); dragging onto a terminal stage closes the deal, and status follows the board.
- **Deal cards** show value (integer HUF), probability (marked when inherited from the stage), expected close, a rotting flag, the document chain and the invoice status. Value and close date edit in place. Columns cap at 25 with "load more".
- **Quotes, contracts and certificates chain onto the DEAL** once one exists; a contract and a certificate inherit their parent's deal.
- **Weighted forecast** (Analytics → Forecast): Σ value × probability by expected-close month, per pipeline and overall, split commit/upside at a configurable threshold and compared against the monthly revenue target. Closed deals are excluded — a forecast that grows when something closes is not a forecast. Deals with no close date are bucketed as *unscheduled* rather than dropped.
- **Quarterly recalibration**: a deterministic job compares each open stage's configured probability against its actual win rate and raises a Signal Engine proposal at n≥20 and a gap of ≥10 points. No Claude call; nothing self-modifies.
- Migration record: `docs/migrations/p4-deals.md`.

### 4.26 Custom Fields — v2 (P5/1)
- Owner-defined fields on **Lead, Company and Deal**, per workspace: text, number, date, single-select, multi-select, checkbox, URL, with a required flag and an archived flag.
- A **definition registry plus one typed JSON column per entity**, not a column per field — adding a field must not be a migration, and the physical schema stays identical across tenants so the tenant guard and RLS keep meaning what they say. Validation is a zod schema built from the definitions, server-side.
- **Type and key are immutable; archive is the only removal.** Changing either would reinterpret every stored value, and deleting a definition would strand values nothing can read or erase.
- Fields appear on the record, as optional table columns, in the filter builder, in CSV import and export, and in search where the type is textual. They join the GDPR erasure cascade, and anonymization clears the whole object.

### 4.27 Duplicate Merge — v2 (P5/2)
- Candidates by shared tax id (certain), shared domain (strong), or fuzzy-same name (suggestive), each pair reported once under its strongest reason. Lead detection is narrower: identical email, or a fuzzy-same name *at the same company*.
- Merge shows a field-by-field comparison with smart defaults (a value beats an absence; between two values the newer record's wins), then re-links every activity, message, call, meeting, document, email thread, task, deal, outcome, subscription and learned address mapping.
- The loser is **tombstoned, never deleted**, so a bookmark or an external system's stored id still resolves — through a chain, if it has been merged twice. Tombstones drop out of tables, boards and search.
- **Reversible for 30 days**, restoring by the ids the merge actually moved rather than by whatever now points at the survivor. Grant-gated on `data.merge`, audit-logged both ways.

### 4.28 CSV Import v2 — v2 (P5/3)
- **Saved mapping templates** per source, reusable and updated in place when re-saved under the same name.
- **A validation preview with a reason per row** — bad email, bad URL, nothing identifying, duplicated in the file, already here, a custom-field value the definition refuses — and a per-row skip. Skip-or-update decides what a match with an existing lead means.
- Every import is a tracked **ImportBatch**; created and updated rows carry the batch id, and the batch stores what each row looked like before and after.
- **Rollback within 7 days** deletes what the import created and reverts what it updated — and REFUSES, naming each row, when a person has touched it since. A refused rollback is a no-op, never a partial one. Owner-only, like the single-lead delete.

### 4.29 Automation (workflow-lite) — v2 (P7/5), extended to boards in v5 (P20/5)
- **WHEN** a trigger fires — a lead or deal reaching a stage, a quote accepted, a meeting outcome logged, a task overdue by N days, a lead arriving from a source, **a task created / moved to a section / completed / re-prioritised / reassigned** — **IF** a flat list of field comparisons all hold (custom fields included) — **THEN** run up to five actions in order.
- Actions: create a task, **prepare an email DRAFT**, add or remove a signal tag, move to Not now, notify a user, notify a **team**, and on the task triggers: set the priority, set a due date by offset, assign, add or remove a tag, move to a section, copy a follow-up off a template board.
- **Board rules watch one board**; a rule with no board watches the whole workspace, which is what every rule written before board automations existed is. A **task action on a non-task trigger is refused** at save time and again at run time: a rule that saves, fires and does nothing for ever is the hardest automation bug to notice. A rule may not move a task to a section on **another** board.
- Task triggers fire on what actually changed: reordering inside a column is not a move to a section, editing a note is not a priority change, and reopening a task is not a completion.
- **The email action drafts and stops.** There is no send path from the engine (CLAUDE.md hard rule #2); a person opens the draft, reads it and sends it.
- Twenty rules per workspace, Owner-gated, each with a kill switch and a version stamped onto every run. The cap **fails loudly** — the twenty-first rule is refused with a sentence and nothing is dropped to make room.
- **Cycle protection is two rules**: a rule cannot re-trigger itself, and no more than three chained rule executions run per originating event — the second is what stops a mutually-triggering pair. A task action that is itself a trigger (setting a priority *is* a priority change) genuinely wakes the engine again, carrying the chain, so the guard catches the loop and writes the refusal down. An action that changes nothing does not wake it at all.
- The execution log records **every evaluation, including the no-matches**, because "why did my rule not fire?" is what a run log is for — with the per-action outcomes and the chain depth, so "2 of 3 actions ran" can say which one did not.


### 4.30 Email sync — v2 (P2)
Two-way per-user mailbox sync (Gmail first, behind a `MailProvider` interface). Backfill of the last 90 days limited to addresses that match a known lead or company; incremental sync every two minutes. Threads render on the lead's Inbox tab; replies are composed and sent through the user's own mailbox, never through a campaign. Reply analysis (Haiku) runs only when a person opens an unread inbound message — never during backfill.

### 4.31 Global search, saved views, bulk actions — v2 (P3/1, P3/2)
Postgres full-text + trigram search across leads, companies, deals, documents, threads and notes, typo-tolerant and ranked. Filter builder over the core fields, saved as named views (personal or shared). Bulk actions apply to everything matching the filter, not just the visible page — the score gate is still enforced per lead, and skipped ones are reported.

### 4.32 Tasks — v2 (P3/3), extended through v5 (P18–P20)

The task module is the second half of the product: the pipeline says what is
happening to a lead, and this says what anybody is doing about it. Its full
capability set:

**The task itself.** This is a first-class task, not a note attached to a lead:
type (call / email / todo / follow-up), title, note, due
datetime, **start datetime** (a task due Friday that takes three days is not a
Friday problem), assignee, done state, priority, free-text tags, source (set
when the system raised it), and a polymorphic link to a lead, company, deal,
document or project. Created from anywhere; merged into the Today Queue at its
due time; overdue tasks reach the Monday digest. **Project milestones are
tasks** (§4.38), which is why they appear in every task surface without any of
them knowing what a milestone is.

**Boards, sections and loose tasks.** Boards hold sections (columns on the
kanban, headings in the list) and tasks rank within a section on sparse
positions, so a drag is one write. `boardId` is nullable and stays that way: a
follow-up raised from a lead or a signal is a **loose** task with no board, and
every surface says so rather than hiding it. Board templates are boards with a
flag — a template *is* a board, so "new board from template" is a copy and
relative due offsets become real dates on use.

**Structure within a task.** Subtasks, one level deep; a parent never completes
from its children and completing a parent never completes them. Dependencies
("this cannot start until that finishes") with cycle detection that names the
loop it found. Comments with @-mentions stored as ids at write time.
Attachments. Recurrence, which **spawns the successor on completion** rather
than filling the board with future copies. **Checklists** (P20/3): light steps
inside one task, capped at fifty, shown as "3/7" on the card, promotable to a
real subtask in one action — and ticking every one of them does **not**
complete the task.

**Views over the same rows.** Board, list, **My Work**, **timeline/Gantt**,
**calendar** and **workload** (P18, P19). My Work is the cross-board personal
view: everything assigned to you including loose tasks, in Overdue / Today /
This week / Later / No date buckets, with dragging between buckets rewriting
the due date and each bucket stating what a drop into it does. It and the
Today Queue compute due-ness with **one function** so they cannot disagree.
Grouping by section, assignee, priority, due bucket, tag or an Owner-defined
field; **a regroup never moves the card between columns.** Saved views extend
the existing `SavedView` table rather than adding a second one. Every view
choice lives in the URL, so a view is linkable and Back closes what it opened.

**Estimates and time** (P20/1). Estimates in whole **minutes** (1.5h is exactly
90 minutes; 0.1h is not exactly six of anything), entered and read as hours. A
parent's estimate is either its own or **computed from its subtasks**, and the
UI states which mode is in use. One running timer per person, enforced by a
partial unique index rather than by hope; manual entries; variance against the
estimate; a per-board time report and an export.

**Owner-defined fields on tasks** (P20/2), in the same `CustomFieldDef` table
and through the same validator as leads, companies and deals — one field
system, one GDPR path — filterable, groupable and exportable.

**Bidirectional entity links** (P20/4). Tasks always knew what they were
about; every lead, company, deal and project now shows its open and recently
completed tasks in a panel, with inline create ("add a task for this lead",
pre-linked), inline complete and a count badge on the header. A task that
genuinely spans two entities carries the extra one in a **join table**;
`tasks.entity_type`/`entity_id` remain the single-entity fast path and reads
union the two. Following a task out of an entity carries the way back.

**Board automations** (P20/5) — see §4.29; they are the same rule engine, not a
second one.

**Collaborators and delegation** (P20/6). `assigneeId` stays **one**
accountable owner — "everyone is responsible" is how tasks die. Beside it:
**collaborators**, who are working on it and see it in their own My Work behind
a toggle, and **followers**, who merely watch. Reassignment stamps
`delegatedBy`/`delegatedAt` and writes a `TaskEvent` trail (the same shape as
`MembershipEvent`), so a task that went Anna → Béla → Anna is visible as that.
A first assignment is **not** a handover. Notifications say three different
things to the three relationships.

**Bulk actions** (P17/1) — complete, assign, set priority, set a due date, add a
tag, move to a section, delete — over everything matching the filter rather
than the visible page, with per-row rules still applied individually and every
skipped row reported with its reason.

### 4.33 Notifications — v2 (P6/1)
In-app notification centre with unread count, per-type preferences per user, PWA web push (VAPID) and an email-digest fallback that batches rather than sending per event. Types cover replies, escalation, callbacks, due tasks, quote accepted/declined, meetings, campaign circuit-breaker, sync failures, pending proposals, new sign-in, and visitor signals (§4.35). 90-day retention.

### 4.34 Undo, inline edit, command palette, onboarding — v2 (P7)
Six-second undo on stage moves, task completion, bulk actions and archive-deletes, implemented as server-side inverse operations rather than a client illusion. Inline editing in the tables and on deal cards. ⌘K palette built on the same search API as the top bar, with a `g`-prefixed navigation map and a shortcut overlay. A first-login tour and a "getting started" checklist.

### 4.35 Signal layer — v3 (P8)
A first-party measurement script (~1.5 KB over the wire) on the audit report, quote and booking pages and on the self-serve landing: opens, referrer, viewport class, reading time by heartbeat, scroll depth and time per section. **No cookies** — session continuity is a random token in sessionStorage, so the pages carry a notice line and a `/privacy` page rather than a consent banner. Do-Not-Track and Global-Privacy-Control are honoured at the source: those visitors leave a bare view and nothing else.

Company-level identification by reverse DNS, a minute after a session opens so the reading time it reports is real. A PTR whose domain **is** a company's domain is `high`; one that merely resembles a company's name is `medium` and renders as "valószínűleg". Consumer ISPs are refused outright. Most visitors are never identified and the UI says so. For a page addressed to a company, "did the recipient open it" needs no guessing at all.

Raw IP addresses are held at most 24 hours, purged hourly, kept only so the reverse lookup can run; what survives is a salted hash and the company guess. Session detail dies at 90 days. Erasing a lead takes their visits and signals with them.

### 4.36 Email verification — v3 (P9/2)
Layered and cheapest-first: syntax, a throwaway-domain list kept in the repo, role-address detection (flagged, never blocked — for a small business `info@` **is** the owner's inbox); then MX or implicit-MX; then an optional paid verifier behind an adapter, null by default so nothing leaves the server unless a key is configured. Statuses are stored on the contact with a date and go stale after 90 days. A cold campaign cannot be armed until its audience is verified: invalid addresses are excluded automatically, risky ones need a decision per address.

### 4.37 1:1 email tracking — v3 (P9/1)
For personal mail sent from the app through the user's own mailbox; cold campaign mail keeps its Mailgun webhooks and is not double-instrumented. A per-message toggle (default on) injects a first-party pixel and rewrites links through a redirect that takes an **index into links stored at send time** — never a URL, because an endpoint that accepts one is an open redirect. The visible text of a link never changes. Every tracked message carries a one-line notice; with the toggle off the message carries no pixel, no rewritten link and no notice at all. An open is labelled a signal, not proof. 90-day retention, then deletion.

### 4.38 Revenue layer — v3 (P11/1)
Client and Subscription entities with an append-only event log, so the MRR movement chart is exact rather than reconstructed. Revenue tab: MRR, movement, ARR, client count, average revenue per client. Traffic-light client health from deterministic rules (payment lateness, months since contact, support flag, subscription age) with the thresholds visible and editable — no AI. Monthly BDR commission computed from payments actually received, exportable as a branded PDF, Owner-only and audit-logged.

### 4.39 Delivery projects — v3 (P11/2)
A won deal offers a project built from a versioned milestone template. **A milestone is a task**: the table holds a position, a kind and a foreign key, while the title, due date, owner, note and done state live on the Task — so a milestone reaches Today Queue, My Tasks, the overdue sweep and the Monday digest without any of them being taught what a milestone is, and there is exactly one done flag. Every template ends in a `teljesítésigazolás` milestone, and a project cannot be closed while it is open: a delivered project whose certificate was never issued is an invoice that cannot be sent.

### 4.40 Self-serve audit — v4 (P12/1)
A public landing on the audit domain: one URL field, a queued audit with live progress, and a deliberately incomplete teaser (score, three findings, both screenshots). The full report unlocks through a form with **two separate checkboxes** — a required one to deliver the report, and an optional, unchecked marketing consent stored with its text version, timestamp and IP. Leads arriving without marketing consent are visibly restricted and excluded from campaign audiences. Anti-abuse: per-network daily cap, honeypot and timing check, blocklists for our own and client domains, a concurrency ceiling, and a check on what the submitted hostname actually resolves to. Funnel counts (visits → audits run → emails captured → consented) reach the Friday report.

### 4.41 Quote follow-up rules — v4 (P14/3)
A small rule engine over §4.35's quote measurements. Three seeded rules with editable thresholds: read repeatedly and still unsigned; long on the price and never reached the scope; opened once and then silence. Each fires once per quote, never on an accepted one, and produces a task plus an optional draft a person sends. Firings are logged with whether the quote was accepted afterwards, so the review can say which rules were followed by a signature rather than which fire most.

### 4.42 Post-meeting follow-up kit — v4 (P13/2)
Logging an outcome assembles a kit: a thank-you draft (one Sonnet call, human-edited before sending), the audit PDF worth attaching, quote lines drawn deterministically from the workspace's own service catalogue for whatever was ticked as discussed, and a follow-up task at +3 days. It is a checklist, not an outbox — each line's done-state is read from the draft, the quote and the task themselves.

### 4.24 Settings / Admin
ICP & score weights, gate threshold, targets, frame library, template management, **workspace management (§7), user & grant management,** Mailgun config (transactional + cold domains), **cold-email compliance gate & counsel sign-off record,** booking-page config, Számlázz.hu Agent keys, registry API keys, API keys, **Claude budget caps,** data retention, audit log, feature flags.

Added in v2: **Fields** (§4.26), **Data quality** — duplicate candidates, merge history and import batches (§4.27, §4.28), **Automation** (§4.29), **Branding** (white-label letterhead), **Security** — active sessions with per-device revoke, and **Notifications** — the per-type channel matrix.

## 5. Claude API usage (frugal by design — see §6)

| Use case | Model | Trigger | Cached |
|---|---|---|---|
| Lead research card | Sonnet 4.6 | Manual button only | Until profile text changes |
| Message draft / critique | Sonnet 4.6 | Manual button | — |
| Reply analysis | Haiku 4.5 | On reply logged | — |
| Prospector batch classify | Haiku 4.5 | Manual, 1 call / ~25 rows | 30 days per search |
| Audit pitch summary | Haiku 4.5 | Toggle, off by default | 30 days per domain |
| Meeting brief | Sonnet 4.6 | On booking | Regenerate manual |
| Signal Engine | Sonnet 4.6 | Weekly cron | — |
| Daily insight | Haiku 4.5 | Daily cron | — |
| Document scope paragraph | Haiku 4.5 | Manual, optional | — |

**v2 added no Claude call sites.** Deals, custom fields, merge, import v2, rate limiting, performance, inline editing, undo, the command palette, onboarding and workflow-lite are all deterministic. The quarterly stage-probability recalibration in particular is arithmetic on purpose: asking a model to compute a win rate is how a probability becomes a guess.

All calls server-side; prompt registry versioned in repo; JSON-schema-validated structured outputs with repair-retry; **Anthropic prompt caching** on the long static system prompts (ICP definition, brand voice) to cut input costs further. Verify model names/pricing at docs.claude.com at build time.

## 6. Credit-minimization strategy (hard requirement)

1. **Deterministic first.** Places API finds businesses; PSI + local checks audit websites; templates render documents. Claude never does what an API or regex can.
2. **Model tiering.** Haiku for classification/summaries/analysis; Sonnet only where writing quality is the product (research cards, outreach drafts, briefs, weekly analysis).
3. **Manual triggers, no auto-fanout.** Nothing calls Claude on page load or on save; research/classify/summarize are buttons.
4. **Caching.** Research cards, audit summaries, prospect classifications cached (30 days or until source changes); duplicate calls short-circuit.
5. **Batching.** Prospector classification batches rows; Signal Engine runs weekly on aggregates, not per event.
6. **Prompt caching + tight prompts.** Static system content cached; page text pre-trimmed (strip nav/boilerplate) before it hits the API.
7. **Budget caps.** Per-workspace daily/monthly USD cap; meter on Dashboard; calls beyond cap queue for the next day with a clear message.
**Projected cost at full usage** (25 researches + 25 drafts + 10 analyses/day, weekly jobs): **≈ $20–45/month.** Places API and PSI budgeted separately (~$10–30/month depending on prospecting volume; PSI is free).

## 7. Multi-workspace architecture ("SaaS-shaped, not SaaS")

- **Workspace** = one operating company (Venture CO Group first; e.g. a Turkish entity or engH later). All business data rows carry `workspace_id`, and isolation is enforced twice: the mandatory Prisma tenant guard rewrites every query, and Postgres **Row-Level Security** refuses cross-workspace rows at the database. The second belt was written early and was inert for months — the application connected as the database owner, and a superuser bypasses RLS whatever `FORCE` says. Workspace-scoped queries now run on a separate pool as a `NOSUPERUSER NOBYPASSRLS` role that declares the workspace on every query; `DB_RLS` switches it, and an isolation test proves it holds **with the tenant guard removed**. `prismaUnsafe` keeps the owner connection deliberately: sign-in reads global tables before any workspace exists, and public pages resolve unlisted slugs across tenants.
- **Users are global; memberships are per-workspace** with a role + grant set (Fanni can be BDR in Workspace A only; Tamas is Owner everywhere). Workspace switcher in the UI shell.
- Per workspace: branding (logo, colors, letterhead), template sets, Mailgun domain, ICP config, targets, Claude budget, data-retention policy, feature flags.
- No public signup, no billing engine. New workspaces are provisioned by the Owner from Settings. If this ever becomes sellable SaaS, the tenancy model already supports it — that is deliberate but out of scope.

## 8. Data model (delta from v1.0)

```
Workspace(id, name, legal_name, brand_json, mailgun_config, claude_budget, retention_days)
Membership(id, user_id, workspace_id, role, grants[])
ProspectSearch(id, workspace_id, keywords, location, ran_at, cost, results_json)
AuditResult(id, company_id, url, score, checks_json, flags[], verdict,
            pitch_summary, screenshots[], created_at, expires_at)
Template(id, workspace_id, type[quote|contract|certificate|email], lang,
         body, variables[], version, status)
Document(id, workspace_id, lead_id, type, template_version_id, payload_json,
         totals_json, status, watermark bool, pdf_url, chain_parent_id)
EmailLog(id, workspace_id, lead_id, document_id, to, subject, mailgun_id,
         status[queued|delivered|opened|bounced], at)
Call(id, workspace_id, lead_id, outcome, note, duration, callback_at, by, at)
Campaign(id, workspace_id, name, segment_query, frame_id, status, compliance_note,
         daily_cap, started_at)  -- + CampaignStep, CampaignRecipient(suppressed bool)
Referrer(id, workspace_id, kind[person|company], name, linked_company_id)
  -- Lead gains: source, referrer_id
RegistryData(company_id, tax_id, reg_number, legal_name, headcount_band,
             revenue_band, status_flags, fetched_at)
DealOutcome(id, lead_id, result[won|lost|postponed], reason, value, competitor, at)
BookingPage(id, workspace_id, host_user_id, slug, meeting_types_json, buffers)
QuoteAcceptance(id, document_id, accepted_by_name, company, ip, user_agent, at)
AuditShare(id, audit_id, slug, expires_at, first_opened_at, open_count)
Invoice(id, workspace_id, document_id, szamlazz_id, number, pdf_url,
        status[prepared|submitted|issued|paid|failed], at)
ClaudeUsage(id, workspace_id, use_case, model, tokens_in, tokens_out, cost, at)

-- v2 (playbook-v2 P2-P7)
MailAccount / EmailThread / EmailMessage / AddressLink        -- two-way email sync (P2)
Task(id, workspace_id, type, title, due_at, entity_type,      -- polymorphic link (P3/3)
     entity_id, assignee_id, done_at, source)
SavedView(id, workspace_id, entity, owner_id, shared,         -- filters + columns + sort (P3/2)
          filters, columns, sort, position)
Notification / NotificationPreference / PushSubscription      -- notification centre (P6/1)
Pipeline(id, workspace_id, key, name, position, is_default)   -- deals layer (P4)
DealStage(id, pipeline_id, key, name, position, probability,
          rotting_days, kind[open|won|lost])
Deal(id, workspace_id, lead_id, company_id, title, value,     -- integer HUF
     currency, expected_close_at, probability, pipeline_id,
     stage_id, stage_entered_at, owner_id,
     status[open|won|lost], closed_at, lost_reason, source)
  -- Document, Subscription and DealOutcome gain deal_id
CustomFieldDef(id, workspace_id, entity[lead|company|deal],   -- Owner-defined fields (P5/1)
               key, label, type, options, required, archived, position)
  -- Lead, Company and Deal gain custom_fields (typed JSON)
MergeRecord(id, workspace_id, entity, survivor_id, loser_id,  -- 30-day undo (P5/2)
            snapshot, choices, revert_until, reverted_at)
  -- Lead and Company gain merged_into_id + merged_at (tombstones)
ImportTemplate(id, workspace_id, name, source, mapping)       -- CSV import v2 (P5/3)
ImportBatch(id, workspace_id, filename, template_id, status,
            created_count, updated_count, skipped_count,
            records, rollback_until, rolled_back_at)
  -- Lead and Company gain import_batch_id
UndoEntry(id, workspace_id, user_id, kind, label, inverse,    -- server-side undo (P7/2)
          expected, undone_at, expires_at)
WorkflowRule(id, workspace_id, name, trigger, trigger_config, -- workflow-lite (P7/5)
             conditions, actions, enabled, version)
WorkflowRun(id, workspace_id, rule_id, rule_version, trigger,
            entity_type, entity_id, status, detail, results, depth, at)
  -- Workspace gains deals_config; User gains lock_count, tour_seen_at,
  -- checklist_hidden_at
-- v1.0 entities (Company, Lead, Activity, Message, Frame, Meeting, Insight,
-- Target, User, AuditLog) all gain workspace_id.
```

## 9. Integrations

| Integration | Depth | Notes |
|---|---|---|
| Google Places API | Core (Prospector) | Text Search + Details; budgeted, cached |
| Google PageSpeed Insights | Core (Auditor) | Free API |
| Headless renderer | Auditor screenshots | Playwright server-side |
| Mailgun | Transactional + cold email | EU region, **two domains: mg.ventureco.group (transactional) and cold.ventureco.agency (cold)** — reputation fully isolated; routes for inbound replies, webhooks |
| Opten / Céginformáció API | Registry enrichment & dedupe | Adószám as dedupe key; subscription cost to be priced at build |
| Számlázz.hu Számla Agent | Invoice handoff | Per-workspace key, human confirm before submit |
| LinkedIn | Assistive only | Extension reads user-viewed pages; deep links; no scraping/sending |
| Google Calendar | Meetings | Event + brief |
| Claude API | Per §5–6 | Server-side, budget-capped |
| CSV | Import/export | |

## 10. Non-functional requirements

- **Responsive:** full mobile usability (≥360px). Mobile priorities: Inbox, Today Queue, Pipeline (swipe columns), document approval/send. Desktop-first for Prospector tables, Template Editor, Analytics. PWA installable (icon on Fanni's phone), no offline writes in Lite.
- **GDPR:** as v1.0 (legitimate-interest LIA, ≤72h erasure, 12-month auto-anonymization, EU data residency incl. Mailgun EU, Anthropic DPA) **plus:** audit/prospect data is public business data — but persons in it are still data subjects; retention applies. Legal documents contain client personal data → per-workspace retention policy, export on request. *Counsel review required; not legal advice.*
- **Legal-document safety:** DRAFT watermark default, legal-review footer, audited finalization, template versioning for reproducibility.
- **Security:** email+2FA, RBAC+grants, RLS tenancy isolation, secrets in manager, audit log on grants/exports/deletes/watermark-removal.
- **Performance:** audit run ≤30s with progressive results; research ≤15s streaming; UI <200ms.
- **Availability:** business-hours tool, 99%, nightly backups, 30-day retention.

## 11. Acceptance criteria (v1.1 additions)

1. A keyword+city Prospector run returns a business list with website-presence flags without any Claude call, and "Add as lead" creates a deduped company record.
2. A URL audit completes in ≤30s, produces score + flags + verdict with zero Claude calls when the summary toggle is off, and attaches "outdated website" signals to the lead automatically when thresholds fire.
3. A lead can be created fully manually with no AI step, and behaves identically in the pipeline.
4. Fanni's account cannot open any Documents generator; after Tamas assigns `documents.quote.create` in Settings, she can — no redeploy, and the grant change appears in the audit log.
5. A quote generated from a template renders with DRAFT watermark, correct totals from line items with commission/markup presets, and sends via Mailgun with the PDF attached; delivery status appears on the lead timeline.
6. Quote → contract → completion certificate chain links correctly and each stage's status is visible on the pipeline card.
7. Editing a template creates a new version; previously generated documents re-render byte-identically from their original version.
8. A second workspace can be provisioned from Settings; a user assigned only to Workspace B sees zero rows from Workspace A (verified at the database policy level).
9. The Claude budget cap, set to $1/day, visibly blocks further AI calls that day with a clear message, while all deterministic features keep working.
10. The full daily loop (queue triage, inbox replies, stage moves, document approval+send) is completable on a 390px-wide phone screen.
11. All v1.0 acceptance criteria still pass.
12. An audit share link renders the branded report publicly, logs the first open to the lead timeline, and expires on schedule.
13. A quote acceptance page records name + timestamp + IP, flips the quote to `accepted`, notifies the Owner, and pre-fills the contract — and the Accept step is implemented behind an interface a future in-house e-signature can replace.
14. The Cold Email module cannot start a campaign in a workspace without a recorded counsel sign-off; every cold email contains a working unsubscribe that suppresses instantly across all campaigns; a reply arrives in the Inbox via Mailgun routes.
15. A call logged with "callback Thursday 14:00" produces a Today Queue item at that time, including on mobile.
16. Entering a company name with a registry match offers enrichment; two leads with the same adószám cannot both be created; a company under liquidation shows a warning on quote generation.
17. A lead marked `won` with a value appears in win/loss analytics, and Signal Engine's next weekly run includes close-rate (not just reply-rate) in its proposal evidence.
18. Booking a slot on the public booking page creates the meeting, the brief, and confirmations without manual steps.
19. The Monday digest arrives per user per workspace and reflects that workspace's data only.
20. From an acknowledged certificate, "Prepare invoice" submits to Számlázz.hu only after explicit confirmation, and the returned invoice number appears on the document chain.
