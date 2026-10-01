# Claude Code Playbook v6 — Outbound Motor
### F1–F6 · termék-vezérelt leadgenerálás, jóváhagyásos megkeresés, éjszakai futás

*Előfeltétel: a `docs/outbound-motor-spec.md` (v1.1, jóváhagyott) bent van a repóban, és a dokumentációs frissítő prompt lefutott (docs/spec.md + CLAUDE.md). Egy prompt = egy kiadás, tételenként commit, a végén VERIFICATION. Az F1–F4 a teszt API-kulccsal fejleszthető, előfizetés nélkül.*

| Fázis | Tartalom | Előfeltétel | Becslés |
|---|---|---|---|
| F1 | Product + ICPProfile modell és admin | — | 3–4 nap |
| F2 | Cégadat API provider, kvóta, cache | — | 2–3 nap |
| F3 | Jelölt-szerzés, szűrés, audit, kontakt-vízesés | F1, F2 | 4–5 nap |
| F4 | Vázlatgenerálás + jóváhagyási sor | F3 | 3–4 nap |
| F5 | Gmail-küldés, aláírás, follow-up | F4 + a Workspace-fiók | 3–4 nap |
| F6 | Éjszakai futás, reggeli összefoglaló, mérés | F5 | 3–4 nap |

---

## F1 — Product és ICPProfile

```
Implement phase F1 of docs/outbound-motor-spec.md: the Product and ICPProfile models with their admin surfaces. No sourcing or sending yet. One commit per numbered item.

1. PRODUCT MODEL. Per spec §3.1: name, slug, category (own_service | partner_solution), partner (supplier name, nullable), problemSolved, valueProps[] (each a claim plus its evidence), proofPoints[], priceBand, assets[] (label + URL), status (active | paused | retired), language (HU | EN), and references — a list of reference companies each carrying { companyName, taxNumber (nullable), isClient boolean, note }. The isClient flag is load-bearing per decision 6: only a true client may be named in outbound copy, a targeting-pattern reference never may. Enforce this in the data layer with a typed accessor (e.g. nameableReferences()) so the draft generator in F4 cannot accidentally use a non-client reference — do not leave it to prompt discipline.

2. SEGMENT TAXONOMY. A seeded, workspace-editable catalogue of the 19 segments in spec §3.2(a): biztosítók, bankok és pénzintézetek, magánklinikák és egészségügy, gyógyszertárak, logisztika és fuvarozás, gyártás, nagykereskedelem, építőipar, vendéglátás, kiskereskedelem, IT és szoftver, tanácsadás és könyvelés, ügyvédi irodák, ingatlan, oktatás, utazás és turizmus, autóipar, energetika, mezőgazdaság. Each segment carries: display name, a TEÁOR code set (include + exclude), a name-fragment set (10-25 fragments for the harvesting in F3), an optional curated seed list (company names or tax numbers), and a sourcingHint enum (name_harvest_strong | name_harvest_weak | seed_list | places) that tells the UI which channel actually carries this segment. Seed realistic starting values for all 19 — for the name fragments, favour words that genuinely appear in Hungarian company names (klinika, rendelő, fogászat, egészségközpont, medical, diagnosztika, labor for private healthcare; biztosító, biztosítás for insurers; logisztika, szállítmányozás, fuvar, trans for logistics; and so on). Mark IT/consulting/manufacturing as name_harvest_weak, because those companies typically carry fantasy names.

3. ICP PROFILE MODEL. Per spec §3.2: belongs to a Product (a product may have several profiles), and carries segments[] (referencing the taxonomy), sizeBands[] (MICRO 1-9 | SMALL 10-49 | MEDIUM 50-249 | LARGE 250+, mapped to employeeCount with netRevenue as fallback and an explicit includeUnknownSize flag), optional revenue min/max, counties[]/cities[], legalForms[], foundedBefore/After, statusRequired (default "Aktív"), requiresWebsite, auditScoreMin/Max, requiredSignals[], contactRequirement (named_contact | generic_ok), excludeExistingClients, and a dailyQuota used by F6. Implement the size-band resolution as a pure, tested function: employeeCount decides; if absent, netRevenue decides against the band's revenue ceiling; if both absent the candidate is "size unknown" and is included only when includeUnknownSize is set, always flagged.

4. REFERENCE-BASED PROFILE SEEDING ("find companies like these"). Given 1-5 reference companies on a Product, fetch their datasheets (this needs the F2 provider — build the UI and the extraction logic now behind an interface, wire it in F2) and derive a suggested profile: the common principal activities and their TEÁOR codes, the prevailing size band, legal forms, and regions. Present it as a pre-filled, fully editable profile draft, never auto-saved, with each suggested filter showing which references produced it. This is a convenience, not an oracle — the UI must say so.

5. ADMIN UI. A Products section: list with status and active-profile count, a product editor (all fields above, reference rows with the isClient toggle prominently labelled "ügyfelünk — a neve leírható a megkeresésben"), and a profile editor built around the three targeting layers in the spec's order — segments picked from the taxonomy as chips, size bands as toggles, references, then the optional fine filters collapsed behind "További szűrők". Each segment chip shows its sourcingHint so the user sees at a glance which segments will actually produce candidates. Owner-only for editing; BDR may view. All mutations audit-logged and tenant-guarded.

VERIFICATION: all 19 segments seeded with non-empty fragment sets and sensible hints; the size-band resolver matches a fixture table including missing-data cases; a non-client reference is not returned by nameableReferences() and a test proves the draft path cannot reach it; a product with two profiles renders both and each carries its own daily quota. Run the full suite, typecheck and lint.
```

---

## F2 — Cégadat API provider

```
Implement phase F2: the Cégadat API integration behind a provider interface, with quota management and caching. Read https://cegadatapi.hu/dokumentacio for the current contract before coding and note the version you implemented against in docs/integrations/cegadat.md — confirm the details rather than trusting any summary, as the API may have changed.

Known shape (verify): base https://cegadatapi.hu/api, Bearer auth. GET /v1/search?q=&searchType=name|vatNumber|registryNumber&sensitivity=0|1&businessType=&status=&limit=&page= returns summary rows (fullName, shortName, vatNumber, status) and is UNLIMITED on all plans. GET /v1/detail?vatNumber= returns the full datasheet and is METERED — 5,000/month on the Haladó plan we hold. A test API key with six fixture companies is published in the documentation; use it for all development and tests.

1. PROVIDER AND MAPPING. A CegadatProvider implementing search() and detail(), plus a MockProvider driven by committed fixture JSON (capture real responses for all six test companies and commit them scrubbed). Map the datasheet onto our domain: legal name, short name, legal form, tax number, registry number, statistical code, seat (county, city, full address), founded date, status, principal activity + activity list (TEÁOR), net revenue, equity, operating and pre-tax and after-tax result, balance sheet total, employee count, owners, managers (names — this is our contact source), bank accounts, sites and branches, website, phone, email. Store onto Company/RegistryData, extending the schema where fields have no home; keep the existing NAV verification as the authoritative path for legal documents and note in code why both exist.

2. QUOTA MANAGEMENT — treat the 5,000 monthly detail calls as a hard budget. A quota ledger per workspace per month recording every detail call with its purpose and the candidate it served. Before any detail call, a daily allocation check: remaining monthly quota divided by remaining days in the month, with a configurable reserve (default 15%) held back for interactive lookups so a nightly run can never starve a user clicking "Cégadatok lekérése" by hand. On allocation exhaustion the caller receives a typed QuotaExhausted result and the job PAUSES rather than erroring. Surface a quota meter in Settings → Integrations and on the campaign screens. Handle the documented error codes explicitly — in particular the rate-limit/quota responses — with backoff and a clear operator message.

3. CACHING. Detail responses cached 90 days keyed on tax number, with the fetch timestamp exposed in the UI ("cégadat: 2026-09-14"). Search responses cached 7 days keyed on query+params. A cache hit must never consume quota, and the ledger must record hits separately so the quota reporting reflects real consumption. Provide a manual "frissítés" action on a company that bypasses the cache and spends one quota unit, with confirmation.

4. INTERACTIVE USE. Wire the provider into the existing company enrichment flow so a user can resolve a company by name or tax number from the lead/company screen — this replaces the current search-based guessing for Hungarian companies where the API has the answer. Keep the existing Claude-with-web-search path as a fallback for cases the API cannot resolve, clearly labelled as the less authoritative source.

VERIFICATION: all six fixture companies map correctly from committed fixtures; a cache hit consumes no quota and is recorded as a hit; the daily allocation blocks the 101st call when the allocation is 100 and returns QuotaExhausted rather than throwing; the reserve protects interactive lookups when a batch has consumed its share; a manual refresh spends exactly one unit; the provider swaps to MockProvider cleanly for tests. Run the full suite, typecheck and lint.
```

---

## F3 — Jelölt-szerzés, szűrés, audit, kontakt

```
Implement phase F3: the sourcing pipeline up to a contact-resolved, audited candidate ready for drafting. No message generation or sending yet. One commit per numbered item.

1. SOURCING RUN MODEL AND STATE MACHINE. Per spec §3.3-3.4: a SourcingRun (product, profile, channel, started/finished, counters, quota consumed) holding ProspectCandidates with the state machine SOURCED → ENRICHED → FILTERED_IN/FILTERED_OUT(reason) → AUDITED → CONTACT_RESOLVED/NO_CONTACT → DRAFTED → PENDING_APPROVAL → APPROVED/REJECTED(reason) → SENT → REPLIED. Every transition records a reason and timestamp. Filtered-out and rejected reasons are first-class enums, not free text, because F6 reports on their distribution.

2. CHANNEL A — NAME-FRAGMENT HARVESTING (the primary engine, free). For a profile's segments, run /v1/search for each name fragment with sensitivity=1, businessType=company, status active, paging to a configurable depth, deduplicating by tax number into a persistent candidate pool per segment. Record which fragment produced each candidate — F6 measures fragment effectiveness and this is the raw data. The pool persists across runs with a last-seen timestamp; a harvest refreshes rather than rebuilds. Rate-limit politely and make the harvest resumable.

3. CHANNEL B-D. Curated seed lists (resolve names or tax numbers via search into the pool); CSV import with column mapping; and the existing Google Places prospector feeding the same pool. All four channels converge on one pool with one dedupe key (tax number where known, domain+name otherwise).

4. FREE PRE-FILTER BEFORE SPENDING QUOTA. In order: already in CRM by tax number → drop; on the suppression list → drop; previously FILTERED_OUT for this same profile within 90 days → drop; legal form implausible for the profile's size bands (a "Bt." cannot be a large enterprise) → deprioritize, not drop; name obviously out of segment → deprioritize. Then score the remainder (fragment strength, legal-form fit, prior-run learning, freshness) and order the queue. Only now may detail calls be spent, taking candidates in score order until the requested count is met or the daily allocation is exhausted.

5. ENRICHMENT AND LOCAL FILTERING. Detail-enrich in score order, then apply the ICP profile locally: segments via TEÁOR match, size band via the F1 resolver, revenue, region, legal form, status, founded date. Each exclusion records a specific reason with the measured value ("employeeCount 6 below MICRO floor? no — below profile minimum SMALL(10)"). Candidates surviving continue; the rest are FILTERED_OUT and feed the learning data.

6. WEBSITE AUDIT. Batch-audit the survivors with the existing audit engine, honoring its cache and rate limits. A company without a website skips the audit and carries "no website" as its hook signal. Apply the profile's auditScore and requiredSignals filters after the audit.

7. CONTACT RESOLUTION WATERFALL. In order, recording the source at each step: (a) Cégadat emailAddress / phoneNumber and managers[] names; (b) impresszum extraction from the company website, reusing the existing site-fetch code — parse name, email, phone, and the represented-by line; (c) existing CRM contact at the same company; (d) named manager from the registry paired with a generic company address — the greeting is personal, the recipient is the general mailbox; (e) generic info@ only, which switches the draft to the "please forward to the right person" variant; (f) nothing → the candidate moves to the LINKEDIN_QUEUE carrying the manager's name so Fanni can find them manually. Then run the existing email verification (syntax, MX, disposable) and drop invalid addresses to the next waterfall step rather than failing the candidate.

8. RUN UI. A campaign run screen: configuration (product, profile, channel, how many qualified candidates to produce), a pre-run estimate stating pool size, expected quota spend and the share of the monthly budget, requiring confirmation. Live progress by stage with counts. A result view with the full funnel (sourced → pre-filtered → enriched → filtered in → audited → contact resolved) and the drop reasons grouped, because that distribution is how the targeting gets fixed.

VERIFICATION: a harvest over fixture fragments populates the pool without consuming quota; the pre-filter drops a CRM duplicate and a suppressed company before any detail call; the local filter's reasons name the measured values; a candidate with no website carries the no-website signal and skips the audit; the waterfall resolves a named contact from managers[] plus impresszum and falls through correctly to the LinkedIn queue; an invalid email falls to the next step instead of failing the candidate; the pre-run estimate matches actual consumption within a tolerance. Run the full suite, typecheck and lint.
```

---

## F4 — Vázlatgenerálás és jóváhagyási sor

```
Implement phase F4: turning contact-resolved candidates into drafts, and the approval queue Fanni will live in. One commit per numbered item.

1. DRAFT GENERATION. One Sonnet call per candidate through callClaude (budget-checked, logged). Inputs: the Product (problem solved, value props with their evidence, nameable references only — use the F1 typed accessor, never the raw list), the ICP profile and which segment matched, the enriched company data, the audit findings, the contact's name and role, and the language. The system prompt enforces: write in the lead's language; open with the company-specific fact, never with us; one concrete claim backed by evidence; a single low-friction ask (a 15-minute call), no attachments, no pricing; plain text, short paragraphs, no marketing adjectives; subject line under 60 characters referencing the specific finding. Output as structured JSON (subject, body, personalisationPoints[] naming which facts were used) validated with zod.

   HOOK GATE — hard rule from CLAUDE.md: a draft must cite at least one concrete, company-specific fact (an audit finding or a registry data point). If the generator cannot ground the message, the candidate is filtered out as NO_HOOK and no draft is created. Enforce this by validating that every personalisationPoint references a real stored value on the candidate, not merely by instructing the model.

   Variants: the generic-mailbox variant (politely asks for forwarding, names the manager if known) and the named-contact variant. Templates are versioned per product and measured by the Signal Engine.

2. APPROVAL QUEUE — the product's centre of gravity. A dedicated screen built for batch review:
   - Keyboard-first: J/K to move, A approve, E edit, X reject, L send to the LinkedIn queue, and a visible shortcut legend. Target: 20 items reviewed in 10 minutes.
   - Each card shows the email exactly as it will be sent — including the signature — plus: recipient and how the address was resolved, the company with its key registry facts, the audit score and the specific finding used, the product and the ICP profile that produced this candidate, and the personalisation points highlighted inline in the body so the reviewer can see at a glance what makes this message specific.
   - Reject requires a reason from a fixed set (wrong targeting | weak copy | wrong contact | bad timing | already in contact | other+note). This is the learning signal — no reason, no rejection.
   - Edit happens in place, not on another screen; an edited draft records that it was edited and keeps the original for comparison.
   - Header shows today's approvals against the quota and the per-product breakdown.
   - Bulk approve exists but is deliberately limited to candidates the reviewer has opened, so it cannot become a blind "approve all".

3. LINKEDIN QUEUE. Candidates with no usable email, plus anything the reviewer routes there with L: a separate list showing the company, the known manager name, the hook, and a suggested LinkedIn message, with "copy and open LinkedIn" exactly as the existing Outreach Studio does — manual sending, unchanged rules.

4. LEAD CREATION. Approving a draft creates (or links) a Lead with source outbound_engine, carrying the enriched company, the audit, the signals, the hook and the product, placed at the correct pipeline stage, with the draft attached. Rejection does not create a lead but keeps the candidate record for learning and for 90-day re-suppression.

VERIFICATION: a candidate whose facts are all generic produces NO_HOOK and no draft; a personalisationPoint that does not match stored data fails validation; a non-client reference never appears in generated copy (test with a product carrying both kinds); the queue is fully operable by keyboard; rejection without a reason is impossible; approving creates a lead with the correct source and stage. Run the full suite, typecheck and lint.
```

---

## F5 — Gmail-küldés Fanni fiókjából

```
Implement phase F5: sending approved drafts through Fanni's own Google Workspace mailbox. Per the approved decisions, cold outbound sends ONLY from fanni.viragh@ventureco.agency — mg.ventureco.group stays transactional-only and no path may send cold mail from the .group domain. Enforce that in code, not configuration alone.

1. GMAIL SENDING. Extend the existing Google OAuth/Gmail integration with gmail.send and gmail.settings.basic scopes for the outbound mailbox, connected per user in Settings → Email as a separate sending identity from the transactional path. Send approved drafts via the Gmail API so they appear in the account's Sent folder and replies arrive in the real mailbox. Each send records the Gmail message and thread ids on the candidate and the lead.

2. SIGNATURE. The Gmail API does not attach the account's signature automatically — it lives in the client. Fetch it via users.settings.sendAs.get for the sending address, cache it, and compose it into the message body so the sent mail looks exactly like one written by hand. Render the preview in the approval queue with the signature included (F4 already requires this), and handle the no-signature case with a configured fallback block rather than sending bare.

3. SEND GUARDRAILS. A per-mailbox daily cap with a warm-up ramp (start 10/day, +5 every three days to a ceiling of 40, configurable), enforced server-side; sends spaced with jitter rather than fired in a burst; a mandatory unsubscribe line appended per the compliance decision, with one-click suppression that applies across every campaign and to every contact at that company; bounce and complaint handling via the mailbox, with a circuit breaker that pauses sending for the mailbox above a bounce threshold and notifies the Owner. A hard guard asserts at send time that the from-address belongs to the cold sending domain — a wrong domain is a refusal, not a warning.

4. FOLLOW-UPS. Two touches maximum, stop-on-reply, scheduled at the configured offsets. Each follow-up is itself generated and ENTERS THE SAME APPROVAL QUEUE — nothing leaves the system unreviewed. Follow-up drafts reference the first message and must add something (a second finding, a resource), never merely bump.

5. REPLIES. Replies arrive through the existing email sync into the Inbox on the lead's timeline, running the existing intent/objection analysis and the price-mention escalation. A reply stops the sequence immediately and moves the lead to Replied.

VERIFICATION: an approved draft sends from fanni.viragh@ventureco.agency, appears in Sent, and carries the account signature; an attempt to send from a .group address is refused by the guard; the warm-up cap blocks the 11th send on day one; unsubscribe suppresses the whole company across campaigns; a reply stops the follow-up and moves the stage; a follow-up appears in the approval queue rather than sending itself. Run the full suite, typecheck and lint.
```

---

## F6 — Éjszakai futás, reggeli összefoglaló, mérés

```
Implement phase F6: the scheduler that fills the queue overnight, the morning briefing, and the measurement loop. Per spec §4bis.

1. NIGHTLY SCHEDULER. A BullMQ job running on a workspace-configured schedule (default 03:00, weekdays only, timezone-aware). For each active product with a daily quota: first count the drafts still unreviewed from previous runs and produce only the DIFFERENCE — the goal is keeping the queue at target, never stacking it, so Monday does not greet Fanni with eighty items. Then run the F3 pipeline followed by F4 generation until the target is met or the pool is exhausted or the daily quota allocation runs out. Workspace-level total cap (15 initially, 25 after two weeks, configurable) distributed by product priority when the sum of product quotas exceeds it. Per-candidate failures are isolated: a failing candidate is parked with a reason and retried the next night; no single failure aborts a run. Everything is idempotent and resumable — a job restarted mid-run must not double-spend quota.

2. POOL EXHAUSTION HANDLING. When a segment's pool runs dry, this is a normal state and not an error: trigger a name-fragment harvest for the next run, record the exhaustion, surface it in the morning briefing with concrete suggestions (extend the fragment set, widen the size band, add neighbouring counties, switch the segment to a seed list given its sourcingHint), and meanwhile reallocate the unused quota to other products.

3. MORNING BRIEFING. On the Dashboard and as the first section of the Monday digest: how many drafts await approval broken down by product; how many candidates dropped and why, grouped by reason; the Cégadat quota position for the month; any segments nearing exhaustion; and, when a product missed its target, the explicit reason. One click goes to the approval queue. Keep it factual and short — this is the first thing Fanni reads every morning.

4. MEASUREMENT AND LEARNING LOOP. Track the full funnel per product, profile, segment and name fragment: sourced → pre-filtered → enriched → qualified → drafted → approved → sent → opened → replied → meeting. Two derived metrics matter most and must be prominent: the APPROVAL RATE (how good the targeting is — a low rate means the profile or the source is wrong, not the copy) and the REJECTION REASON DISTRIBUTION (wrong targeting dominating points at sourcing; weak copy dominating points at the templates). Per-fragment effectiveness feeds a maintenance view that suggests retiring fragments producing candidates that never reach approval, and highlights the strong ones so similar fragments can be added. Extend the existing weekly Signal Engine job to include outbound data in its proposals (template promotion, score-weight adjustments, fragment retirement) — proposals only, approved by the Owner as always, no silent self-modification.

5. COST REPORTING. Per product and per month: Cégadat detail calls consumed, Claude spend on drafts, and the resulting meetings — giving a cost per meeting per product. This is the number that decides which products deserve quota next month.

VERIFICATION: with 12 unreviewed drafts and a target of 15, the run produces exactly 3; a quota-exhausted run pauses and resumes the next night without double-spending; a failing candidate is parked and retried while the run completes; an exhausted segment produces the briefing entry with suggestions and its quota is reallocated; the morning briefing numbers reconcile with the funnel data; the fragment effectiveness view ranks fixtures correctly. Run the full suite, typecheck and lint, then update docs/spec.md and docs/HANDBOOK.md with the operator-facing parts (quota settings, scheduler configuration, fragment maintenance, reading the briefing).
```

---

## Zárás

```
Run the full test suite, typecheck and lint. Verify the F1-F6 VERIFICATION blocks end to end with evidence. Then audit the outbound motor against CLAUDE.md: no send without explicit approval of visible text; no draft without a grounded company-specific fact; cold mail only from fanni.viragh@ventureco.agency; Cégadat quota respected with caching and pausing; non-client references never named in copy; suppression and unsubscribe effective across all campaigns; tenant isolation on every new table. Produce a short operator runbook in docs/HANDBOOK.md covering: creating a product and profile, running a first campaign manually, reading the morning briefing, maintaining name fragments, and what to do when the quota runs low. Tag the release outbound-v1.
```
