# Venture OS Lite — Operator Handbook

For the Owner of a Venture OS Lite installation. Covers the things only you can
do: managing people and their permissions, provisioning workspaces, editing
legal document templates, controlling AI spend, verifying backups, executing a
GDPR erasure request, and running the test suites before you ship a change.

Installation and server maintenance live in [`DEPLOY.md`](DEPLOY.md).
Feature-level behaviour lives in [`spec.md`](spec.md).

---

> ### Security model in one paragraph
>
> Everyone signs in with an email and a bcrypt-hashed password, optionally
> backed by a TOTP second factor. Sessions live as rows in the database, so they
> are revocable and expire after 12 hours. Roles and grants are checked
> server-side on every mutation — not merely hidden in the UI. Five failed
> sign-ins lock an account for 15 minutes.
>
> The three prospect-facing surfaces (`audit.`, `quote.`, `meet.`) are
> deliberately public, reachable only via unguessable slugs.

---

## 0. Where everything is

Settings is two groups of pages, each behind its own menu.

**Your settings** — every member has these, and they are about the person
signed in:

| Page | What is there |
|---|---|
| Settings → **profile** | Name, job title, photo, timezone, language |
| Settings → **sign-in & security** | Password, two-factor, your signed-in devices |
| Settings → **notifications** | What reaches you, and on which channel |
| Settings → **email** | Connect your own mailbox for the Inbox |
| Settings → **browser extension** | The LinkedIn capture extension and its tokens |

**Admin settings** — super admin only, and about how the software behaves:

| Page | What is there |
|---|---|
| admin → **overview** | A map, saying what is still on a default |
| admin → **members & teams** | Invite, roles, capabilities, suspend, remove, ownership |
| admin → **workspace** | Letterhead, menu visibility, custom fields, workflow rules, data quality |
| admin → **sales & delivery** | Targets, quote rules, account health, milestone templates, Signal Engine proposals |
| admin → **site audit** | What the opportunity score is made of, re-audit watches |
| admin → **integrations** | API keys, what they cost, outbound webhooks, invoicing, cold-email sign-off |
| admin → **security & compliance** | Two-factor policy, the audit log and its retention, GDPR |
| admin → **workspaces** | Provision one, copy settings into it, repair one |

> Both pages used to be a single scroll — the admin one was twenty panels in a
> column, and finding any of them meant knowing roughly how far down it lived.
> If you are looking for something this handbook mentions and cannot see it,
> the menu on the left of the settings page is the index.

The **overview** page is worth a minute after any change: it lists what is
still on an out-of-the-box default, in amber. A default nobody chose is the
thing that goes unnoticed for a year.

---

## 1. Users and grants

### Roles vs. grants

Two independent layers:

**Role** (`OWNER`, `ADMIN`, `BDR`, `CLIENT`) — set when a person is added to a
workspace. It governs broad access: only an Owner can change grants, provision
workspaces, finalize legal documents, manage users, or change retention policy.

`CLIENT` is **read-only client access**, and it is not a smaller BDR — see
§1.6 below.

**Grants** — individual capabilities, assigned per user *per workspace*. They
are checked server-side on every mutation, not just hidden in the UI. Turning
one on takes effect immediately; no redeploy, no restart.

The fourteen grants:

| Grant | What it unlocks |
|---|---|
| `documents.quote.create` | Generate quotes from templates |
| `documents.contract.create` | Generate contracts from an accepted quote |
| `documents.certificate.create` | Generate completion certificates |
| `documents.send` | Email a document to a client, and publish its public accept link |
| `templates.edit` | Edit quote/contract/certificate/email templates |
| `signal_engine.approve` | Approve the weekly Signal Engine proposals |
| `exports.run` | Run a full data export, and schedule one |
| `fields.manage` | Define the workspace's own lead/company/deal fields |
| `data.merge` | Merge two companies or two leads |
| `leads.delete` | Hard-delete a lead, in one or in bulk, and roll an import back |
| `settings.manage` | Targets, workflow rules, health thresholds, quote rules, audit scoring |
| `audit_log.read` | Read and export the audit log |
| `public_pages.manage` | Publish and withdraw share links and booking pages |
| `sector_reports.manage` | Commission, generate and publish a sector report |

**Defaults, and why they are not "nothing":**

- **Owner and Admin** carry all fourteen implicitly.
- **BDR** carries everything EXCEPT the five document/template grants. Those
  five decide what the company is legally bound by, and `templates.edit` is the
  same power one step back — it decides what every future document *says*.
  Everything else on the list is the daily job, and gating it was stopping a
  BDR from exporting a list or merging two obvious duplicates.
- **CLIENT** carries nothing, and cannot be given anything. The refusal is
  checked before the grants list is even read, so an entry left behind by a
  role change cannot hand a read-only account a capability.

An implicit capability still shows as a toggle, and **unticking it withdraws
it** — that is written down as a `!`-prefixed entry, and it beats the role
default.

### Granting a capability

1. **Settings → admin → members & teams**.
2. Find the person's row; each grant is a toggle grouped by module.
3. Click the toggle. It saves immediately.

Every grant change is written to the audit log with who changed it, for whom,
which grant, and when.

### Adding someone to a workspace

**Settings → admin → members & teams → invite somebody**: enter their email
address and pick a role. If no user exists with that address, one is created.

What they start with depends on the role, per the table above — a BDR is
useful immediately and needs handing only the document grants. Add those one at
a time; the safe default is to grant nothing legally binding until somebody is
blocked by its absence.

**Inviting by email.** *Settings → admin → members & teams* → **invite somebody**. You
get a single-use, one-hour link. Paste it over a channel you trust, or press
**Email it to them** to send it from the transactional domain — that button is
a deliberate second step, because an invitation that silently fails to arrive
is worse than one you can see on screen.

### Removing access, or standing somebody down

Both are in the product now: *Settings → admin → members & teams*.

**Suspend** is the honest middle ground and usually the right answer. It
revokes every live session at once and `tryGetActiveContext` refuses to resolve
a suspended membership, so a browser left open at 14:00 stops reading the
workspace immediately rather than when its cookie expires. Their history keeps
its author — "who wrote this note" is a question people ask months later.

**Remove** deletes the membership. Use it when somebody was added by mistake.
The last live Owner cannot be suspended or removed: a workspace with no Owner
cannot grant a role or restore itself, and recovering one needs shell access to
the server — that is not a support process, it is an outage.

Both are audit-logged with who did it, to whom, and when.

### 1.5 The member lifecycle, and how somebody leaves

A membership has four states, and the difference between the last two is
the one that matters:

| State | Can sign in | Can be assigned | Owns their records |
|---|---|---|---|
| **Invited** | no | no | — |
| **Active** | yes | yes | yes |
| **Suspended** | no | no | **yes** |
| **Removed** | no | no | reassigned on the way out |

**Suspend** is almost always the right answer. It signs them out at once,
takes them out of every assignee picker, and leaves everything they own
theirs and still attributed. Reinstating gives back **exactly** the role and
capabilities they had — stored on suspension, not recomputed, so an explicit
grant is not silently lost.

**Remove** is a four-step flow, not a button:

1. **The impact report** — how many leads, open deals, open tasks, upcoming
   meetings, booking pages, saved views and unpublished posts they hold. A
   dialog asking "are you sure" asks a question you cannot answer without
   this.
2. **Where it goes** — a person or a team per category, or one target for
   all. Open deals and open tasks *cannot* be left unassigned: an unowned
   open deal is money nobody is chasing, and an unassigned open task is work
   that has quietly become nobody's.
3. **Their mailbox and calendar** — disconnected. Threads already filed
   against a lead **stay**: they are correspondence with a client.
4. **Type their name.** Checked on the server too.

Then it runs in one transaction. If any part fails, nothing changes — a
half-applied removal is the worst outcome available.

**What removal does not do** is erase their footprint. Their name stays on
everything they created, `who logged this call` stays, and the membership row
survives so the audit trail still reads. Removal ends access; it does not
rewrite what somebody did.

**Deleting an account entirely** is only possible once they are in no
workspace at all, and waits 30 days before anything is erased — restorable
until then.

**Transferring ownership** asks for your password and your six-digit code. A
session is not proof enough for something irreversible; a borrowed laptop is
a session. The last Owner cannot suspend, remove or demote themselves — a
workspace with no Owner cannot restore itself, and recovering one needs
shell access to the server.

### 1.5b Inviting people

*Settings → admin → members & teams → invitations.* One person, or paste a
spreadsheet column — every row is reported back, sent or skipped with the
reason.

The invitee sets their own password and **registers an authenticator before
their first sign-in**. That is not optional: 2FA offered later is 2FA half a
team never turns on.

Invitations last 7 days, can be resent (a new token each time — the old one
dies), and can be revoked. The list shows pending, expired and revoked with
the resend count, because five invitations nobody has accepted is a
conversation to have rather than a button to keep pressing.

### 1.5c Teams

*Settings → admin → members & teams → teams.* Name, colour, members, a lead.

**Teams carry no permissions.** What somebody may do stays their role and
their capabilities — so there is only ever one answer to "why can Anna do
that". What a team gives you is an assignment target, a filter, a grouping
for analytics, an escalation route, and a page showing who is on it and how
loaded each of them is.

Deleting a team is refused while anybody is on it; archive it instead.

### 1.5d The access review

*Settings → admin → members & teams → access review.* The three lists an
auditor asks for: who has not signed in for 60 days, who holds the
capabilities that bind the company, and which invitations have been out
longer than their window.

They are findings, not failures — somebody dormant may be on leave.

**Exporting a member's data** gives what the system holds about them *as a
person*: profile, memberships, sign-in history, their timeline, notification
settings, teams. It deliberately does **not** include the leads they worked.
Those are somebody else's personal data, and handing an employee a file of
four hundred prospects' details because they asked what we hold about them
would be a breach dressed as a subject-access response. Every export is
audit-logged.

> **Employee data is not prospect data.** A lead is held for a commercial
> purpose, under legitimate interest, with a retention window and an erasure
> right that cascades. An employee is held because they work here — a
> different basis, a longer retention (employment records outlive an
> engagement), and a different erasure story: their *authorship* of work
> records is the company's record of what happened, not their personal data
> to erase. That is why removal keeps "created by".

---

### 1.6 Client access (read-only)

A client who can see their own project and their own documents — and nothing
else — is what makes the delivery side sellable. Set it in *Settings → admin →
members & teams*: open the person, pick the company under **Client access**, save.

They see **one company's** projects with their milestones, and its
**finalized** documents. Not drafts: a quote still carrying its DRAFT
watermark is a working document, and a client seeing a draft price is how a
negotiation goes wrong before it starts. No leads, no pipeline, no other
client, and every other screen in the product simply redirects them back to
their portal.

They cannot change anything. That is enforced in three independent places —
they hold no capability, the database layer refuses every write on their
behalf, and the shell will not render a page outside the portal — so
forgetting one of them in a future screen would leak a read, never a change.

Two things worth knowing:

- **Changing this signs them out of every device.** A role change has to bite
  immediately, in both directions.
- **A client with no company sees nothing.** That is deliberate, but it reads
  like a broken feature, so the users panel refuses to make somebody a client
  without picking one, and the row says `no company — sees nothing` if one ever
  ends up that way.

### 1.7 Requiring two-factor authentication

*Settings → admin → security & compliance* → **Require two-factor authentication**.

Anybody without an authenticator is sent to the enrolment screen on their next
click. That is enrolment, not a lockout: nobody is signed out, they register
one and carry on. Before you flip it, the panel says how many people that will
be. Turning it back off removes nobody's authenticator.

---

### Locked out / lost second factor

Both are fixed from the server console:

```bash
docker compose -f docker-compose.prod.yml run --rm worker \
  npm run set-password -- person@ventureco.group            # new password, clears any lock
docker compose -f docker-compose.prod.yml run --rm worker \
  npm run set-password -- person@ventureco.group --clear-2fa  # also removes TOTP
```

Setting a password revokes every existing session for that account.

---

## 2. Workspace provisioning

A workspace is a complete tenant: its own companies, leads, documents,
templates, campaigns, budget and settings. Nothing crosses between workspaces.

Use a second workspace when you are running sales for a genuinely separate legal
entity or brand — **not** to separate teams or regions within Venture CO Group.
Data cannot be moved or reported across workspaces afterwards.

### Creating one

**Settings → admin → workspaces → create workspace.** You need:

- **Name** — internal label shown in the switcher.
- **Legal name** — the exact registered company name. This is printed on every
  quote, contract and certificate as `{{workspace.legal_name}}`. Get it right.

The creator becomes its Owner and is switched into it. A new workspace starts
with the default document templates and default settings.

### After creating one

Do these before generating any document from it:

1. **Settings → admin → workspace → letterhead** — tax number (adószám) and registered address. They fill
   `{{workspace.tax_id}}` and `{{workspace.address}}` on legal documents.
2. **Settings → admin → integrations** — the verified Mailgun sending domain for this
   workspace, if it differs from the installation default.
3. **Settings → admin → workspaces** — see §5. New workspaces default to **$2/day**.
4. **Settings → admin → sales** — scoring thresholds, if this entity targets a different
   customer profile.

### Switching

The workspace switcher is in the top bar. It only ever lists workspaces you are
a member of, and your choice is stored on the session row server-side — there is
no client-writable value to tamper with. A session pointing at a workspace you
are not a member of is ignored and repaired to one of your own. Verified by the
isolation test suite.

---

## 3. Editing templates

Templates produce every quote, contract and completion certificate. There is
**no AI in this path** — documents render from a versioned template plus
variables, and nothing else. That is what makes them reproducible.

Requires the `templates.edit` grant.

### The editor

**Templates** in the left rail. Pick a type (Quote / Contract / Certificate /
Email) and a language (HU / EN).

- Type `{{` to get autocomplete for available variables.
- The live preview on the right renders with sample data.
- **Unknown variables are flagged** as you type. Fix them before saving — an
  unknown variable renders as empty text on a client-facing document.

### Versioning — the important part

**Saving creates a new version. It never edits the existing one.**

Documents already generated keep rendering from the version they were created
with, byte-identically, forever. So:

- Changing a template does **not** retroactively change any quote you have
  already sent.
- A contract signed last month still renders exactly as signed, even after ten
  template revisions.

After saving, the new version is a **draft**. It is not used for new documents
until you **activate** it. Activate it from the version list.

### Working practice

1. Save a draft.
2. Read the preview end to end — especially totals, VAT wording and legal
   clauses.
3. Activate.
4. Generate one throwaway document and read the PDF before sending anything to
   a client.

### The DRAFT watermark

Every generated legal document carries a **DRAFT watermark** until an Owner
finalizes it. Finalizing is an audited action — who removed the watermark, on
which document, and when. Do not finalize a document you have not read in full.

---

## 4. Outreach and the human-edit rule

Outreach Studio (**Outreach** in the rail) runs a three-step LinkedIn sequence
per lead: a connection note capped at 300 characters, then up to two follow-ups.

**Claude drafts; you send.** The system never sends outreach itself — "Mark
sent" only records that *you* sent it, after "Copy & open LinkedIn".

Two rules are enforced on the server, not just in the interface:

1. **A Claude-drafted message cannot be marked sent until you have changed it.**
   Adding spaces does not count; the comparison ignores whitespace. If you press
   Mark sent on an untouched draft, the server refuses and says so. The intent
   is that nothing leaves in Claude's voice unedited.
2. **Two follow-ups with no reply parks the lead as `Not now`**, with a wake-up
   in 30 days. Nobody gets chased indefinitely.

Also available: **Critique** (Claude reviews your text and names what is weak),
**Blank draft** (write it yourself, no AI at all), and one-click **audit hooks**
that insert a finding from the lead's website audit as an opening line. Hooks
are assembled from audit data, not generated, so they cost nothing and cannot
invent a fact.

Both Draft and Critique are manual buttons and count against the AI budget
below. Nothing on this screen calls Claude on load.

---

## 5. AI budget caps

Every Claude call is metered and charged against a **per-workspace daily USD
cap**. When today's spend reaches the cap, further AI calls are refused with a
clear message and **every deterministic feature keeps working** — prospecting,
website audits, scoring, the pipeline, documents, email, invoicing. You lose
research cards, outreach drafts, meeting briefs and the weekly analysis until
midnight.

### Setting the cap

**Settings → admin → workspaces**. Default is **$2.00/day** per workspace.

Sensible starting points:

| Usage | Cap |
|---|---|
| Trying it out | $1/day |
| One BDR, normal day | $2–3/day |
| Heavy prospecting week | $5/day |

Set it low first. It is easier to raise a cap that bit than to explain a bill.

### Watching spend

**Analytics → AI usage** shows spend per day, broken down by use case and model.
Every single call is logged to `ClaudeUsage` with its token counts and computed
cost.

### What controls cost

The system is built to be frugal, and these properties are enforced in code:

- **No AI on page load or save.** Every call is a manual trigger.
- **Haiku by default.** Sonnet only for research cards, outreach drafts, meeting
  briefs and the weekly analysis.
- **Results are cached.** Re-opening a lead does not re-run its research.

If spend surprises you, look at **Analytics → AI usage** grouped by use case
before raising the cap — it is usually one workflow, not general drift.

### When the cap is hit

You get: `Claude daily budget reached for workspace … AI calls resume tomorrow.`

You can raise the cap and retry immediately. The counter resets at midnight UTC.

---

## 6. Backup verification

Backups run nightly at 03:30 via cron (`DEPLOY.md` step 8). The script already
verifies each dump is readable before it counts it. That is not the same as
knowing you can restore — **verify quarterly**.

### Monthly: is it running?

```bash
ls -lht /var/backups/ventureos/ | head -20
tail -30 /var/log/ventureos-backup.log
```

You should see roughly 14 pairs of files, the newest from last night, and a log
ending in `done — N database backup(s) retained`.

Red flags:

- Newest file older than 48 hours → cron is not firing. Check `crontab -l`.
- Database dump under ~50 KB → the dump is probably empty. Investigate now.
- `FAILED:` anywhere in the log → read the line above it.

### Quarterly: restore drill

There is a script for this now, and it runs on the server:

```bash
cd /opt/ventureos-lite
./scripts/restore-drill.sh
```

It loads the newest dump into a **throwaway database beside the live one** and
asks it questions, because a `pg_restore` into an empty schema exits zero and
reports success. It checks that the whole schema came back, that there is a
workspace and a user (without those nobody can log in to a restored system at
all), how far the migration history reaches, how fresh the *data* is rather
than the file, whether the row-level-security policies survived, and whether
the files archive has anything in it. Then it drops the scratch database.

It does not touch the live database, does not delete a backup file, and lists
the files archive rather than extracting it. It exits non-zero if anything
failed, so it works from cron:

```
0 4 1 */3 * cd /opt/ventureos-lite && ./scripts/restore-drill.sh >> /var/log/ventureos-drill.log 2>&1
```

**What each failure means, and the order for a REAL restore** — including the
one instruction that decides whether a botched restore is recoverable (rename
the live database, do not drop it) — is in
[`docs/restore-drill.md`](restore-drill.md). Write down each drill in the table
at the bottom of that file: an undocumented drill is one nobody can prove
happened.

### What is and is not backed up

| Backed up | Not backed up |
|---|---|
| Database (all tenants) | TLS certificates (Caddy re-issues them automatically) |
| `/data/files`: PDFs, screenshots, exports | The `.env` file |
| | Redis queue state (in-flight jobs; they re-queue) |

> ⚠️ **Keep a copy of `.env` somewhere safe and separate.** It is deliberately
> excluded from backups, and without it a restored database is not a running
> system. A password manager entry is fine.

> ⚠️ **Backups live on the same server as the data.** Pull them down weekly, or
> enable Vultr snapshots. A single-machine loss otherwise takes both.

---

## 6b. The audit log: reading it, exporting it, keeping it

*Settings → admin → security & compliance → audit log*. Owner-only, and read-only — an audit log with a
delete button answers no question at all.

**Exporting it.** Pick a date range (or none, for everything) and press **CSV
letöltés**. The actor column carries a name, not an id: an extract whose actor
column holds cuids answers "somebody" to every question worth asking. The file
carries a BOM, because it is opened in Excel far more often than in a text
editor. The export is itself logged — a record of who read the record of who
did what.

This is the thing to reach for first in a data-protection incident. "Log in and
scroll, fifty rows at a time" is not an answer to a regulator, a client's
security questionnaire, or a lawyer.

**Keeping it.** The default is **for ever**, deliberately: no default should
quietly shred a workspace's audit history. Pick a period and the panel says how
many rows the next nightly sweep will remove before you save. Below ninety days
is refused — a log that rotates faster than a quarter cannot answer a question
about last quarter, which is the main thing anybody asks it.

Every sweep that removes anything leaves an `audit_log.pruned` entry behind,
and those are never pruned. Otherwise a gap in the log is indistinguishable,
after the fact, from somebody covering their tracks.

---

## 6c. Outbound webhooks

*Settings → admin → integrations → kimenő webhookok*. Owner-only.

Nine events go out — lead created and stage-changed, deal stage-changed and
won, document finalized and accepted, invoice issued, meeting booked, audit
completed. This is what makes the software integrable instead of an island.

Three things to know:

- **The secret is shown once**, on creation and on rotation. Write it down
  then. Not because it cannot be read back, but because a screen that
  re-displays it for ever is a screen somebody eventually screenshots.
- **Press "Teszt küldése"** after setting one up. Otherwise the only way to
  find out whether it works is to wait for a real lead to move and then guess
  whether the silence means "no events yet" or "wrong URL".
- **The panel refuses a lot on purpose**: plain `http`, bare IP addresses,
  `localhost`, the compose service names, anything internal. An outbound
  webhook makes this server fetch a URL somebody typed, and this server sits on
  a Docker network beside the database. The hostname is also resolved before
  each send, because a public name can point at `127.0.0.1`.

Twenty consecutive failures switches an endpoint off and says why. The last
five deliveries per endpoint are on screen with their response codes.

Receiver documentation, with working verification code, is in
[`docs/integrations/webhooks.md`](integrations/webhooks.md) — hand it to
whoever is building the other end.

---

## 6d. Copying settings into a new workspace

*Settings → admin → workspaces → create workspace* → **Copy settings from**.

A new workspace already gets the defaults. This copies what somebody actually
tuned: brand and letterhead, custom fields, pipelines and stages, document and
project templates, workflow rules, quote rules, scoring and gates, targets,
hidden menu items. Tick what you want.

**Only settings.** Leads, companies, documents, invoices, the audit log,
members and API keys never travel — that is another company's data, and the
whole tenancy guarantee is that it cannot cross. The Claude budget does not
travel either: a spending cap is a per-workspace decision.

It is additive and never destructive — anything the new workspace already has
is left alone — so it is safe to run against a workspace already in use, and
safe to run twice. **Workflow rules arrive switched off**: a rule that lands
armed would trip automation nobody has read on the first lead somebody enters.
Read them, then enable them.

Both workspaces get an audit-log entry, so the source's own log shows that its
configuration was read.

---

## 7. GDPR erasure procedure

A data subject has the right to have their personal data deleted. This system
completes the live deletion **well within 72 hours** and hard-deletes — it does
not flag rows as hidden.

### Executing an erasure request

Owner only. **Settings → admin → security & compliance → Erase lead data**.

1. Select the lead.
2. Type the confirmation phrase exactly as shown.
3. Confirm.

This queues an erasure job that hard-deletes the lead and cascades through every
derived record: activities, messages, calls, meetings, audit results and their
share links, campaign recipients, quote acceptances, email logs, and generated
documents (subject to the document-retention setting below). Completion is
written to the audit log.

Verify it landed:

```bash
docker compose -f docker-compose.prod.yml logs worker | grep -i erasure
```

### Before you erase: legal retention

Hungarian accounting law requires issued invoices to be retained for eight
years. **An invoice is not erasable personal data you may delete on request.**

**Settings → admin → security & compliance → `eraseDocumentsOnErasure`** controls whether
generated documents are destroyed along with the lead. Decide this deliberately,
with your accountant:

- **Off (recommended)** — invoices and signed contracts survive erasure, meeting
  the statutory retention obligation. Everything else goes.
- **On** — documents are destroyed too. Only appropriate for leads that never
  reached an invoice.

If a data subject with issued invoices requests erasure, erase everything else
and tell them the invoices are retained under a legal obligation (GDPR Art.
17(3)(b)). That is a valid and expected answer.

### Backups and erasure

Erasure cannot rewrite already-written backup archives without corrupting them.
Instead, erasure is satisfied by **expiry**: every backup is permanently deleted
within the 14-day rotation, so personal data in a pre-erasure snapshot is gone
at most 14 days later.

This is why `RETENTION_DAYS` must stay at 14. Raising it lengthens the window in
which erased data still exists, and breaks the stated policy. Full reasoning:
[`backup-erasure-policy.md`](backup-erasure-policy.md).

### Automatic anonymization

Separately from requests, a monthly job pseudonymizes person-level fields on
leads with **no activity for 12 months**, while keeping aggregate statistics
intact. Your win-rate history survives; the individual's name and contact
details do not.

Adjust the window in **Settings → admin → security & compliance → `anonymizeAfterDays`**
(default 365). The job is idempotent — re-running it changes nothing.

### Data export (subject access requests)

Requires the `exports.run` grant. **Settings → admin → security & compliance → Run export**
produces a CSV bundle written to `/data/files/exports/`, downloadable through
the authenticated file route. Every export is audit-logged.

### Where the data lives

All data is on your EU server (Vultr Frankfurt/Amsterdam) and in Mailgun's EU
region (`MAILGUN_EU=true`, enforced at boot). Claude API calls send prompt
content to Anthropic for processing; they are not used for training. Note this
in your privacy policy.

---

## 8. Running the tests yourself

Three checks gate every change (CLAUDE.md, "definition of done"). The first
three are instant and need nothing running:

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # ESLint
npm test              # vitest — unit + DB-backed integration
```

`npm test` needs Postgres up, because the integration tests prove tenant
isolation against the real database rather than a mock.

### The browser suite (Playwright)

This one drives a real browser through the critical flows: capture → score →
gate, quote → PDF → send, and workspace isolation.

```bash
# 1. Database and Redis (leave running; they persist between runs).
docker compose up -d db redis

# 2. Schema — only after a schema change, or on a fresh database.
npx prisma db push
npm run db:seed

# 3. Browser binaries — once per machine.
npx playwright install chromium

# 4. Run everything. The dev server starts and stops on its own.
npx playwright test
```

Useful variations:

```bash
npx playwright test workspace-isolation   # one spec by name
npx playwright test --headed              # watch it happen
npx playwright test --ui                  # pick and re-run interactively
npx playwright show-report                # after a failure
```

**Expected result: 94 passed, 1 skipped, in about 3–4 minutes.** The skip is
deliberate — one public audit test needs a real registrable domain and cannot
mean anything on `localhost`, so it opts out rather than asserting something
false.

The suite runs on a single worker on purpose. Every spec shares one seeded
workspace and one dev server, and the lead specs create, filter, re-stage and
delete leads; in parallel they revalidated pages underneath one another and
produced failures that moved around between runs. Serial costs a couple of
minutes and makes a red result mean something. Do not raise `workers` in
`playwright.config.ts` without first giving each worker its own workspace.

### Two things that look like failures but are not

**The environment warning on startup.** Every run prints:

```
Environment check failed — 2 problems:
  ✗ MAILGUN_WEBHOOK_SIGNING_KEY — is required when MAIL_PROVIDER=mailgun
  ✗ NEXTAUTH_SECRET — is still the placeholder
```

That is the boot check doing its job on a development `.env`. It refuses to
start in production and continues in development, which is what you want
locally. Do not "fix" it by putting real secrets in the development `.env`.

**`FILES_DIR`.** `.env` sets `FILES_DIR=/data/files` — that path is *inside* the
app and worker containers, where docker-compose mounts the files volume. A test
run on your own machine cannot create `/data`, so `playwright.config.ts` points
host-side runs at `data/files` in the repo instead (already gitignored). Nothing
about the container changes, and you do not need to edit `.env`. If you ever
want a different location, export `FILES_DIR` before running and it is honoured.

---

## 9. What v2 added, in one place

The v2 release (playbook-v2 P4–P7) added five Owner-facing things. Each has its
own section above where it needed one; this is the map.

### Deals, pipelines and the forecast

A **lead** is a person you are trying to reach. A **deal** is a piece of work
with money attached. Everything up to Replied is the lead board; from Qualified
onward it is the deals board, and the two link across so nobody has to remember
which one a name is on.

Pipelines are **yours to shape**: *Web projects* and *Grants* come seeded because
they close on completely different clocks, and you can rename, re-weight and
re-order the stages of either. Each stage has a default probability (what the
forecast weighs a deal there at) and a rotting threshold (how long a card may sit
before it turns amber).

**Analytics → Forecast** multiplies value by probability and groups by expected
close month, split into *commit* (at or above your threshold) and *upside*.
Closed deals are excluded on purpose — a forecast that grows every time
something closes is a scoreboard, not a forecast.

Once a quarter the system compares each stage's configured probability against
what actually closed and, if the gap is real and the sample is at least twenty,
raises a proposal in the approval queue. It never changes a number on its own.

### Your own fields

**Settings → admin → workspace → fields.** Add fields to leads, companies and deals: text, number,
date, single or multi select, checkbox, URL. They show on the record, as
optional table columns, in the filter builder, in CSV import and export, and in
search where they hold words.

Two things the screen deliberately will not let you do, both for the same
reason — they would silently change what your existing data MEANS:

- **change a field's type.** A number turned into a dropdown leaves every value
  already stored invalid, and nothing could tell you which records had stopped
  making sense. Archive it and add a new one.
- **delete a field.** Archiving keeps the values readable (and erasable when
  somebody asks); deleting would strand them.

### Data quality: duplicates and imports

**Settings → admin → workspace → data quality** lists records that look like the same company or the
same person — a shared adószám is certain, a shared domain is strong, a similar
name is a suggestion — and every import that has run.

**Merging** shows you both records field by field and lets you pick a side for
each before anything moves. The losing record is kept as a tombstone, so old
links still work, and the whole merge can be undone for **30 days**.

**Imports** are undoable for **7 days**. The rollback removes what the import
created and puts back what it changed — and it will REFUSE, naming the records,
if somebody has worked on them since. That refusal is the feature: a rollback
that quietly discards a colleague's correction is a second import, not an undo.

Rolling an import back deletes leads, so it is Owner-only, the same rule as
deleting a lead by hand.

### Automation

**Settings → admin → workspace → workflow rules.** Rules of the form *when* something happens, *if* it
looks a certain way, *then* do this. Twenty per workspace, Owner-only, each with
an on/off switch and a run log.

The one thing worth knowing before writing a rule: **the email action prepares a
DRAFT and stops.** It writes the message onto the lead and waits for a person to
open it, read it and send it. There is no setting that makes it send, and there
is no code path that would — that guarantee is the same one that governs every
other message this system touches.

The run log records **every** evaluation, including the times a rule considered
an event and decided not to act. That is deliberate: the question people
actually ask is "why did my rule *not* fire?", and a log of successes cannot
answer it.

A rule cannot trigger itself, and no more than three rules run in a chain from
one original event. Two rules that trigger each other are stopped by the second
limit, not the first.

### Sessions, and getting signed out less

A session now lasts **30 days**, or **7 days without use** — whichever comes
first. The old behaviour signed you out mid-week; the idle limit is the part
that actually protects a laptop left in a drawer.

**Settings → sign-in & security** lists your signed-in devices by something you can
recognise ("Chrome on macOS"), highlights the one you are using, and lets you
revoke any of the others individually. A sign-in on your account raises a
notification to you and to nobody else.

Five failed sign-ins lock the account, and each consecutive lock waits longer —
fifteen minutes, then thirty, an hour, four hours, a day — resetting the moment
somebody gets in. Every lockout is on the audit log.

---

## Quick reference

| Task | Where |
|---|---|
| Change your password / 2FA | Settings → sign-in & security |
| Sign out other devices | Settings → sign-in & security |
| Grant a capability | Settings → admin → members & teams |
| Add a person | Settings → admin → members & teams |
| New workspace | Settings → admin → workspaces |
| Edit a template | Templates → pick type + language → save → activate |
| Change AI cap | Settings → admin → workspaces |
| Add your own field | Settings → admin → workspace |
| Merge two duplicates | Settings → Data quality → Compare… |
| Undo a merge (30 days) | Settings → Data quality → recent merges → Undo |
| Roll an import back (7 days) | Settings → Data quality → imports → Roll back |
| Write an automation rule | Settings → Automation → New rule |
| See why a rule did not fire | Settings → Automation → show run log |
| Revoke one device | Settings → security → Revoke |
| Convert a lead to a deal | open the lead → Deals → Convert to deal |
| Change a deal's value | Deals → click the amount on the card |
| Read the forecast | Analytics → Forecast |
| Set the commit threshold | Analytics → Forecast → Commit threshold |
| Everything by keyboard | ⌘K, or `?` for the full map |
| See AI spend | Analytics → AI usage |
| Draft outreach | Outreach → pick a lead → ✦ Draft with Claude |
| Erase a lead | Settings → Data & privacy → Erase lead data |
| Run an export | Settings → Data & privacy → Run export |
| Check backups | `ls -lht /var/backups/ventureos/` |
| Restore a backup | [`DEPLOY.md`](DEPLOY.md) → Troubleshooting §4 |
| Run the fast checks | `npm run typecheck && npm run lint && npm test` |
| Run the browser suite | `npx playwright test` (see §8) |

### Audited actions

These are permanently recorded with actor and timestamp:

- grant changes
- data exports
- lead erasures
- DRAFT watermark removal (document finalization)
- invoice submissions to Számlázz.hu
- password changes, 2FA enable/disable, and session revocations (bulk and single)
- account lockouts after repeated failed sign-ins
- adding, editing and archiving a custom field
- merging two records, and undoing a merge
- running an import, and rolling one back
- creating, editing, enabling, disabling and deleting an automation rule
- every undo, alongside the action it reversed
- changing the forecast's commit threshold

The audit log cannot be edited from the UI.

## The capture extension's four states

"Read it with the extension" used to fail with *"The extension needs permission to
read LinkedIn pages. Open its popup and allow it"* — and the popup had no such
control. The cause was simpler than the message suggested: LinkedIn access is an
**optional** host permission, so installing grants nothing, and nothing in the
extension ever asked for it. A permission with no request path can only be missing.

There are four distinct states and each needs a different action. The app now
detects them and shows the right one.

| State | What you see | What to do |
|---|---|---|
| **Not installed** | "Install the capture extension" | Settings → Extension → download, then load it in Chrome |
| **Installed, not connected** | "Connect the extension" + version | Settings → Extension → paste a capture token |
| **Installed, no LinkedIn access** | "Allow LinkedIn access" | Press it — a tab opens; allow it there, come back |
| **Ready** | "Read it with the extension" | Press it |

### Why granting needs its own tab

`chrome.permissions.request()` is only honoured from a click **inside the
extension**. A click on a button in this web app is a gesture in the *page*, and it
does not carry across — so the app can only ever open the extension's own page and
let the granting click happen there. One extra step, and the only version that
works. The same control also lives in the extension popup, where a click already
counts.

### Why LinkedIn access is not requested at install

Anyone who only pastes profile text never needs it, and a host permission in the
manifest shows a alarming install-time prompt to everybody. The cost of that choice
is the request path above. The profile content script is registered dynamically
once permission exists, for the same reason.

To revoke: **chrome://extensions** → the extension → Site access.

### Checking the states by hand

1. **Not installed** — open /leads in a browser without the extension.
2. **Not connected** — load the extension, do not paste a token.
3. **No LinkedIn access** — connect it, then remove LinkedIn from Site access in
   chrome://extensions.
4. **Ready** — allow LinkedIn access, paste a profile URL.

---

# Ami a v3 óta a tiéd

Ez a szakasz csak azt sorolja, ami **neked, tulajdonosként** ad új gombot vagy új döntést. A többi a `docs/spec.md`-ben van.

## Bevétel és ügyfelek

**Analytics → Revenue.** MRR és mozgása (új / bővülés / szűkülés / lemorzsolódás), ARR, ügyfélszám, egy ügyfélre jutó átlagos bevétel, és az előfizetések táblája. A mozgás-diagram nem visszaszámolt: minden változás eseményként rögzül, tehát pontos.

**Ügyfél-egészség.** Piros / sárga / zöld ügyfelenként, tisztán szabályokból: számla-késés, hány hónapja nincs érintkezés, támogatás-jelző, előfizetés kora. **Nincs benne AI**, és a küszöbök szerkeszthetők: *Beállítások → Admin → client health*. A pirosak a hétfői összefoglalóba is bekerülnek.

**Jutalék-riport.** Havi elszámolás abból, ami **ténylegesen befolyt** (nem abból, amit kiszámláztunk), ügyfelenként, a 12 hónapos ablakon belül. Márkás PDF, bérszámfejtésre. Csak tulajdonos látja, és a generálás naplózódik.

## Szállítás

**Projects.** Megnyert dealből egy kattintással indul a projekt, sablon szerinti mérföldkövekkel. A mérföldkő **egy teendő** — ott van a Today Queue-ban és a saját listádban is. **A projekt nem zárható le, amíg a teljesítésigazolás nincs kiállítva**: pontosan az a lépés marad el, amire a számla vár.

**Sablonok:** *Beállítások → Admin → milestone templates*. A szerkesztés új verziót hoz létre; a futó projektek a sajátjukat őrzik, tehát egy sablon-módosítás nem írja át, mire szerződtél.

## Ki olvassa, amit kiküldünk

**Public Pages → „Ki nézte?"** Az átvilágítási riportokon, ajánlatokon és a foglalóoldalon látszik, hányan és mennyi ideig olvasták, és — ahol megállapítható — melyik cég. A találat sosem tény: ahol nem biztos, ott „valószínűleg" szerepel, és a látogatók többsége azonosítatlan marad. A leghasznosabb sor az, hogy **a címzett cég megnézte-e** — ott nem kell találgatni.

**Ajánlat-követő szabályok:** *Beállítások → Admin → quote follow-up rules*. Három szabály (többször megnyitva; sokáig az áron; elcsendesedett), mindegyik **ajánlatonként egyszer** indul, és **teendőt plusz piszkozatot** hoz létre — küldeni innen semmit nem lehet. A panel megmutatja, melyik szabály után fogadtak el ajánlatot.

**Levél-visszajelzés.** A saját postafiókodból küldött válaszoknál bekapcsolható a megnyitás- és kattintás-visszajelzés (a szerkesztő „Követés" jelölője). A megnyitás **jelzés, nem bizonyíték** — a képblokkolás és az Apple Mail előtöltése mindkét irányban torzít. Kikapcsolva a levél teljesen tiszta: se pixel, se átírt link, se lábjegyzet.

## Hideg e-mail

**Címellenőrzés élesítés előtt.** A kampány addig nem indítható, amíg a közönség nincs ellenőrizve. Az érvénytelen címek automatikusan kimaradnak; a kockázatosakról (jellemzően `info@`-típusú közös postafiókok) **címenként te döntesz**. Fizetős ellenőrző szolgáltató opcionális: *Beállítások → Admin → Integrációk*. Nélküle is fut minden beépített ellenőrzés.

## Találkozó után

**Follow-up csomag.** A kimenet rögzítésekor a rendszer összerakja: köszönő levél piszkozata, a csatolható átvilágítási riport, az ajánlat váza a megbeszélt szolgáltatásokból (a te árkatalógusodból), és egy emlékeztető 3 nap múlva. **Ellenőrzőlista, nem postafiók** — minden sor egy gomb, amit valakinek meg kell nyomnia.

## Beállítások, ahol most vannak

A Beállítások ketté van osztva. **A tiéd** (`/settings`): profilkép, jelszó, 2FA, aktív munkamenetek, mi értesítsen, a bővítmény-tokenjeid és **a saját postafiókod csatlakoztatása**. **A szoftveré** (`/settings/admin`, csak super admin): fejléc és arculat, egyedi mezők, jogosultságok, integrációk, Claude-keret, adatminőség, automatizálás, ügyfél-egészség szabályai, mérföldkő-sablonok, ajánlat-követő szabályok.
