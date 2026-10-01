# Venture OS Lite — UI/UX Design & Development Plan
### v1.1 · companion to the Software Specification v1.1

---

# Part A — UI/UX design

## A.1 Design direction (unchanged core, extended shell)

Dark, calm, premium; purple light as the single energy source; the **Claude rail** remains the signature glowing element. Tokens as v1.0 (`--canvas #00051D`, panel glass, `#310B59→#7427C6` gradient, white logo, Bricolage Grotesque display + Inter). New in the shell:

- **Workspace switcher** at the top of the sidebar (company avatar + name + caret). Switching swaps branding, data, and templates instantly; current workspace name always visible so documents are never generated under the wrong company.
- **"lite" marker** next to the logo — quiet, lowercase, muted; signals v1 without cheapening it.
- **Claude budget meter** above the user chip: thin gradient bar + "$0.84 / $2.00 today". Makes frugality visible and self-policing.
- **Locked-module affordance:** modules a user lacks grants for appear in nav with a small lock and open a "Requires access from your workspace owner" state — features are discoverable, permissions are explicit.

## A.2 Layout & responsive system

**Desktop (≥1100px):** sidebar 228px · main (12-col, max 1400) · contextual Claude rail 340px.

**Tablet (700–1100px):** sidebar collapses to icon strip (56px); Claude rail becomes a slide-over sheet toggled from the topbar.

**Mobile (<700px):**
- Sidebar → **bottom tab bar** (5 slots: Home, Inbox, Pipeline, Prospect, More) — thumb-reachable, matching the on-the-go priorities (triage, replies, stage moves, approvals).
- Topbar condenses to title + workspace initial + search icon.
- Pipeline → horizontally swipeable columns with snap; long-press or a "Move to…" action sheet replaces drag.
- Tables (Prospector, Leads) → stacked cards with the same data hierarchy.
- Claude rail → bottom sheet, swipe to expand.
- Document generation is *reviewable and sendable* on mobile (approve + send flow), but authoring/templating is desktop-first.
- PWA: installable icon, app-like standalone mode. Touch targets ≥44px, `prefers-reduced-motion` respected.

## A.3 New key screens

**Prospector** — search bar row (keyword · location · radius · Run) with a pre-run cost estimate ("~$0.90 Places API"). Results header states the finding in plain language: *"27 plumbers in Budapest · 11 have no website"*. Table rows: name, category, rating, website-presence chip (`No website` in warm amber — that's the money row), phone, actions **Audit site** / **Add as lead**. Saved searches as pills. Optional "Classify with Claude" button carries a small credit badge ("1 Haiku call / 25 rows").

**Website Auditor** — the report is designed to be shown to a prospect, not just used internally: big opportunity score (Bricolage numeral) + verdict chip, then a two-column check grid (pass/fail with plain-language labels: "No mobile layout", "Loads in 6.4s", "Copyright says 2019"), device screenshots side by side, **Opportunity flags** as gradient tags, optional one-paragraph Claude pitch angle, and two CTAs: **Create lead with these signals** and **Export branded PDF**. This PDF is a sales asset — Venture letterhead, one page, zero jargon.

**Documents** — three-tab module (Quotes · Contracts · Certificates) + Templates. Quote builder: client picker (from pipeline), line-item table with preset chips ("pass-through +15%", "production +30%"), live totals with VAT, validity date. Persistent **DRAFT watermark preview** on the right-side PDF pane; "Mark final" is a distinct, Owner-gated, confirm-dialog action (watermark removal = audited). Chain view on each document: Quote → Contract → Certificate as a connected stepper showing status. Send action opens the Mailgun composer (template-driven subject/body, PDF attached, delivery status returns to the lead timeline).

**Template Editor** — desktop-first split view: editor with `{{variable}}` autocompletion left, live preview with sample data right; language toggle (HU/EN); version history rail; empty-variable warnings inline. Register: quiet, technical, precise.

**Settings → Workspaces & Users** — workspace cards (brand color dot, member count, Mailgun status, Claude budget); user drawer with role select + grant checklist grouped by module; every toggle writes an audit entry with a visible "logged" microcopy.

**Growth-module screens (v1.2 additions)** — *Audit share page & quote acceptance page:* the two public-facing surfaces; both are single-purpose, letterhead-branded, mobile-first pages with one action, no navigation, no product chrome — they must read as Venture collateral, not as "a tool". The acceptance page states plainly it records assent (name, time), with the future e-signature slot visually reserved. *Campaigns:* audience preview with live count and compliance-status banner (red until counsel sign-off exists); send-cap and domain-health indicators always visible. *Call log:* one-thumb mobile sheet — outcome buttons sized for use in a parking lot, callback picker with smart defaults (tomorrow 9:00 / Thu 14:00). *Referrers:* a simple ledger view — who sent what, what it became, what it's worth. *Win/loss:* outcome dialog at handoff close with a required reason; analytics gains a "what closes" panel beside "what converts". *Booking page:* the calm public twin of Meetings — day strip, slot grid, three fields, done. *Invoice handoff:* a confirm screen that shows exactly what will be submitted to Számlázz.hu, diff-style, before the button.

## A.4 UX writing additions

Plain outcome verbs remain the rule: "Run audit", "Add as lead", "Mark final", "Send quote". Money and credits are always explicit before the action ("This search costs ~$0.90" / "1 Claude call"). Legal-document states are unambiguous: *Draft — not for signing* vs *Final*. Locked features explain the path, not the wall: "Quotes are managed by the workspace owner. Ask Tamas for access."

---

# Part B — Development plan

## B.1 Build vs. buy — updated

The v1.0 argument stands, and requirements 3–9 settle it: keyword prospecting fused with website auditing, house-rule quote math, HU-language document chains, template versioning, and grant-level access control don't exist in Pipedrive or any off-the-shelf CRM in this combination. Custom is right. Phase 0 still gates the build.

## B.2 Stack (delta)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js 15 + TS + Tailwind, PWA manifest | Responsive from Phase 1, not retrofitted |
| DB | Postgres (Supabase EU) + Prisma, **RLS for workspace isolation** | Tenancy at the database layer |
| Jobs | Inngest/cron | Signal Engine, caches, email webhooks |
| Auditor | Playwright (headless) + PageSpeed Insights API + custom checks | Runs in a worker, not the web process |
| Prospecting | Google Places API | Key + budget alarm in Google Cloud |
| PDF | Headless-Chrome print pipeline from HTML templates | One rendering path for audits, quotes, contracts, certificates, letterhead baked in |
| Email | Mailgun EU + webhooks | Per-workspace domains |
| AI | Anthropic API (Sonnet 4.6 / Haiku 4.5), prompt registry, prompt caching, per-workspace budget middleware | §5–6 of spec |
| Extension | Chrome MV3 | Unchanged |

## B.3 Phases

**Phase 0 — Prove the workflow (week 1, no product code)**
As v1.0 (Sheet + Claude Project) **plus:** run 3 manual "prospector" experiments (Places API explorer + a manual audit checklist on 10 sites) to validate that the audit flags actually predict good conversations. Prompts, fields, and audit thresholds come out of this week.

**Phase 1 — Foundation & core loop (weeks 2–6)**
Auth + **workspace/membership/RBAC-grants model + RLS from day one** (retrofitting tenancy is the classic disaster — it goes first), responsive app shell (sidebar/bottom-bar/switcher/budget meter), lead capture ×3 (manual, LinkedIn paste, CSV) **+ lead source & referrer fields (referral tracking data model lands here even if its UI comes later)**, Lead Engine + score gate, pipeline kanban (touch behaviors included), Outreach Studio, Dashboard + Today Queue, Claude budget middleware.
*Exit: Fanni's daily loop runs in the app on desktop and phone; spec criteria 3, 4 (lock side), 9, 10 pass.*

**Phase 2 — Prospector, Auditor & phone channel (weeks 7–10)**
Places integration with cost preview + caching + saved searches; audit worker (checks, PSI, screenshots, scoring, verdict thresholds); audit→lead signal wiring; branded audit PDF **+ public audit share pages with open tracking; registry enrichment & adószám dedupe (Opten/Céginformáció); call log + callback tasks (mobile sheet + Today Queue wiring)**.
*Exit: criteria 1–2, 12, 15, 16 pass; first real prospecting session produces contacted and called leads.*

**Phase 3 — Documents, email & acceptance (weeks 11–14)**
Template Editor with versioning + variables; quote builder with commission/markup presets; contract + certificate generators; document chain + statuses; DRAFT watermark & audited finalization; Mailgun EU setup (transactional domain), composer, webhooks → timeline; grants UI; **quote acceptance pages with the swappable Accept interface (future in-house e-sign slot)**.
*Exit: criteria 4–7, 13 pass; a real quote goes out and gets accepted through the system.*

**Phase 4 — Intelligence, meetings & reporting (weeks 15–18)**
Inbox + reply analysis + escalation, Meetings + briefs + Calendar, **public booking page**, Content Hub, Signal Engine + approval queue **now fed by win/loss outcomes (outcome dialog + reason taxonomy land here)**, Analytics + Friday report **+ referrer ledger + "what closes" panel + Monday digest emails**, GDPR tooling, second-workspace provisioning test, mobile polish.
*Exit: criteria 8, 17, 18, 19 pass and all earlier criteria hold.*

**Phase 5 — Growth channel & billing (weeks 19–22)**
**Cold Email module** (separate Mailgun domain, warm-up ramp, caps, suppression, inbound routes to Inbox, campaign builder, **compliance gate wired to counsel sign-off record — module ships disabled until that exists**); **Számlázz.hu Számla Agent integration** (prepare→confirm→submit, invoice chain link, payment status polling).
*Exit: criteria 14, 20 pass. Cold email activation additionally requires the recorded legal sign-off — a business gate, not a code gate.*

**Phase 6 — Outbound motor (v6, F1–F6)**
Spec §4.43, build order in `docs/10_ClaudeCode_Playbook_v6_Outbound.md`. F1 products, ICP profiles, segment taxonomy · F2 Cégadat provider, detail quota, 90-day cache · F3 sourcing runs (harvest, seeds, Places, CSV → pool → pre-filter → enrichment → ICP filter → audit → contact waterfall) · F4 grounded drafts and the approval queue · F5 Gmail sending from fanni.viragh@ventureco.agency, follow-ups, replies, unsubscribe · F6 nightly fill, morning briefing, measurement and fragment learning.
*Exit: spec §12 criteria pass; a manual run produces approvable drafts on the test key before the subscription; sending waits on the connected mailbox and the recorded counsel sign-off.*

**Post-Lite backlog (the "másik chatben" extended set slots here):** in-house e-signature (plugs into the Accept interface), plus the extended modules — feature flags are already in place, so they land per workspace without touching Lite behavior.

## B.4 Effort & cost estimate

One senior full-stack contractor + you as product owner; Claude Code as accelerator.

| Item | Estimate |
|---|---|
| Phase 1 | ~18–20 dev-days |
| Phase 2 | ~14–16 dev-days |
| Phase 3 | ~16–18 dev-days |
| Phase 4 | ~16–18 dev-days |
| Phase 5 | ~12–14 dev-days |
| **Total** | **~76–86 dev-days ≈ 19–22 weeks calendar** |
| Contractor cost (HU senior, 60–90 e Ft/day) | **~5.5–7.5 M HUF** |
| Running cost | Supabase+Vercel ~€45/mo · Claude ~$25–50/mo · Places ~$10–30/mo · Mailgun (2 domains) ~$25/mo · registry API (Opten/Céginfo, price on quote) est. 20–50 e Ft/mo · Számlázz.hu Agent ~0–few e Ft/mo · **≈ €150–250/mo total** |

Sequencing advice: **Phases 1–2 already produce a money-making tool** (prospect → audit → contact → meeting). If budget or calendar pressure appears, ship after Phase 2, run on it for a month, then fund Phases 3–5 from the pipeline it creates. Middle path unchanged: you build Phases 1–2 with Claude Code; contract out the PDF/Mailgun/registry/invoice plumbing.

## B.5 Risks (delta)

| Risk | Mitigation |
|---|---|
| Tenancy leak between workspaces | RLS at DB layer + criterion 8 test + audit log |
| Legal-document errors | Deterministic templates (no AI in the render path), DRAFT watermark, versioning, counsel-reviewed base templates |
| Places API cost creep | Pre-run cost estimate, cache, Google Cloud budget alarm |
| Audit false positives (flagging fine sites) | Thresholds tuned in Phase 0 on real sites; verdict is advisory, human decides |
| Mailgun deliverability | EU region, verified subdomain, SPF/DKIM/DMARC at setup, transactional-only keeps reputation clean |
| Scope creep from the extended set | Feature flags + phase exit criteria; extended modules only after Lite is in daily use |
| **Cold email legal exposure (2008. évi XLVIII. tv.)** | Module disabled by default; hard gate on recorded counsel sign-off; unsubscribe + instant suppression |
| **Cold-domain deliverability collapse** | Dedicated domain (cold.ventureco.agency) isolates transactional mail entirely; warm-up ramp, daily caps, audit-score recipient gate, plain-text-first, circuit breaker (bounce >3% or complaint pauses the campaign), weekly reputation check in the Friday report |
| **Wrong data submitted to Számlázz.hu** | Registry-enriched partner data, mandatory human confirm with diff view, invoice prepared-not-issued state, full payload logged |
| **Registry API cost/contract lock-in** | Provider chosen at build on quote; adapter interface so Opten ↔ Céginformáció are swappable |

## B.6 Definition of done (Lite)

All v1.1 acceptance criteria pass on production data; Fanni runs a full week desktop+mobile without a spreadsheet; a real quote→contract→certificate chain completes through Mailgun; a test second workspace provably isolates data; Claude spend for the month lands under the cap; UI audited against brand tokens on both breakpoints.
