# Member and team management — what is built, and what is deliberately not

Reference for the member lifecycle work (§1–§8). The operator-facing version
lives in [`HANDBOOK.md`](HANDBOOK.md) §0–§1; this is the design record.

---

## The shape of it

| Section | Where it lives |
|---|---|
| §1 Lifecycle states, invitations, events, teams, reassignment map | `src/modules/members/{lifecycle,events,reassignment,directory,timeline}.ts` |
| §2 Invitation flow | `invitation-logic.ts`, `invitation-store.ts`, `accept.ts`, `/invite/[token]` |
| §3 Members screen | `settings-users.tsx`, `member-drawer.tsx`, `bulk.ts` |
| §4 Administration actions | `admin-actions.ts`, `removal.ts`, `member-remove-flow.tsx` |
| §5 Teams | `src/modules/teams/` |
| §6 Permission matrix | `permission-matrix.ts`, `settings-permissions.tsx` |
| §7 Access review, employee export | `access-review.ts`, `settings-access-review.tsx` |

Ground rules that hold throughout: every mutation is Owner-gated via
`requireOwner`/`isOwner`, goes through the tenant guard, and writes through
`recordMemberEvent` — which **cannot** write a timeline entry without also
writing an audit entry. That is enforced by the shape of the helper rather
than by remembering to call two things.

---

## Three decisions worth re-reading before changing anything

**1. Teams grant nothing.** Authority is role + grant, resolved by
`src/lib/grants.ts` and nothing else. A team carrying capabilities would be a
second authorization system beside the first, and the two would disagree the
first time somebody was on two teams — at which point "why can Anna do that"
stops having an answer anybody can give. There is no permission logic anywhere
in `src/modules/teams/`, and that is not an omission.

**2. Nothing about permissions is described in prose.** The matrix, the
effective-permissions list and the role-change preview are all `grantAllowed`
and `grantIsImplicit` asked at render time. A hand-written "Admins can do
everything except manage users" is true the day it is typed and a lie after the
model changes, with nothing to catch it because the sentence still reads fine.
`test/unit/permission-matrix.test.ts` walks every role × capability and is the
test that keeps the UI and the code from drifting.

**3. Removal ends access; it does not rewrite history.** `created by`,
`Activity.byUserId`, `Call.byUserId` and every closed deal keep their person.
The membership row survives in `REMOVED`. A call record that changes who made
it is a falsified record.

---

## Explicitly out of scope (§8)

None of the following is built. Each is listed with where it would attach, so
the next person does not have to work that out from scratch.

### SCIM / directory provisioning
**Attachment point:** `src/modules/members/invitation-store.ts` —
`issueInvitation` and `revokeInvitation` are already the only two ways a
membership is created or ended, so a SCIM `POST /Users` maps onto the first and
`DELETE /Users/:id` onto `executeRemoval` with an "unassign where legal" plan.
`MembershipState` already has the INVITED and REMOVED states SCIM expects.

**Why not now:** at two to five users, provisioning is one form. SCIM adds an
endpoint, a bearer credential to rotate, and a mapping table to keep in step
with the role model — configuration surface with no work removed.

### SAML / SSO enforcement
**Attachment point:** `src/lib/auth/index.ts` — the Auth.js config already
takes multiple providers, and `attemptLogin` in `src/lib/auth/login.ts` is the
only place a password is checked. An SSO-only workspace would be a flag on
`Workspace.featureFlags` read at the top of that function.

**Why not now:** the 2FA policy already covers the risk SSO is usually bought
for, and an IdP is a second system to be locked out of.

### Custom roles beyond Owner / Admin / BDR / Client
**Attachment point:** `src/lib/grants.ts`. `grantAllowed(role, grants, grant)`
takes the role as a string and the only role-specific logic is three branches
in that one function. A `Role` table with a grant set would replace those
branches and nothing else — *provided* `DOCUMENT_GRANTS` stays outside it, so a
custom role cannot mint document authority for itself.

**Why not now:** four roles and fourteen per-person capabilities already
express everything a five-person agency has asked for. A role builder is a
feature people configure once and then cannot reason about.

### Guest / external-collaborator accounts
**Attachment point:** the `CLIENT` role is nine-tenths of this already —
read-only, scoped to one company, refused every capability by the resolver, and
confined to `/portal` by the shell. A guest would be the same shape with a
different scope object on the membership.

**Why not now:** `CLIENT` covers the case that exists (a client seeing their own
delivery). A general guest needs a general scoping model, which is per-record
ACLs by another name.

### Per-record sharing ACLs
**Attachment point:** nowhere clean, and that is the finding. Every business
table is scoped by `workspace_id` in the tenant guard and by RLS. Per-record
sharing would mean a second predicate on every read in the application, which
is precisely the thing the guard exists to make impossible to get wrong.

**Why not now:** it would weaken the tenancy guarantee to solve a problem
nobody has at this size. If it is ever needed, it belongs as a *view* concept
(saved views scoped to a team) rather than as an access concept.

### Seat-based billing
**Attachment point:** `liveOwnerCount` and `seatedMembers` in
`src/modules/members/directory.ts` already compute the number a seat count
would bill on, and `MEMBERSHIP_STATE_DEFS[...].seated` is the predicate that
decides who counts.

**Why not now:** this is self-hosted on the owner's own server. There is
nobody to bill.

---

## Deferred rather than out of scope

**Team-scoped saved views.** §5 lists them; they are not built. They need a
`teamId` on `SavedView` and a change to how views are read, and the filter that
actually gets used — "show me this team's people" — already works on the
members table. Noted rather than half-built.

**Per-workspace session timeouts.** §7 lists them. They exist as
installation-wide constants (`SESSION_ABSOLUTE_TTL_MS`, `SESSION_IDLE_TTL_MS`,
`ACCOUNT_MAX_FAILURES`) and are surfaced read-only on the access review panel.
Making them per workspace would put a database read on `tryGetActiveContext`,
which runs on **every request**, for a setting nobody changes twice. Mandatory
2FA stays the one part of the policy that is per workspace, because it is the
part a workspace has an opinion about.
