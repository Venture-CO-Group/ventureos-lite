# Claude Code Playbook v5 — Venture OS
### UI/UX alapréteg, task-nézetek és task-képességek

*Öt prompt, sorrendben kiadva. Egy prompt = egy kiadás, tételenként commit, a végén az adott prompt VERIFICATION blokkja. A sorrend nem önkényes: a P16 közös rétegét a többi négy használja, ezért az megy elsőnek.*

| Prompt | Tartalom | Elemek | Becslés |
|---|---|---|---|
| P16 | Közös UX-alapréteg | C12, C13, C14, C15, C18, C19 | 4–5 nap |
| P17 | Navigáció és üres állapotok | C16, C17, C20 | 2–3 nap |
| P18 | Task — napi nézetek | A4, A5 | 3–4 nap |
| P19 | Task — idő-nézetek | A1, A2, A3 | 4–5 nap |
| P20 | Task — képességek | B6–B11 | 4–5 nap |

---

## P16 — Közös UX-alapréteg

```
Build the shared UX foundation the rest of the app will use. Today these patterns are inconsistent: a repo scan finds inline editing in 0 files, skeleton loading in 1 file, toasts in 7 and undo in 12 with no common layer, and prefers-reduced-motion honored in 1 file. Fix that as infrastructure, not per-screen patches. One commit per numbered item, all matching the workspace branding tokens.

1. INLINE EDITING PRIMITIVE. A single reusable <InlineEdit> family covering text, number, date, select, multi-select, and custom-field types, usable in table cells, detail panels and kanban cards. Behavior: click or Enter on a focused cell enters edit mode; Esc cancels; Enter or blur commits; arrow keys move cell focus and Tab moves right within a table. Commit optimistically with rollback and an explanatory toast on server rejection, and always run server-side validation (grants, tenant guard, score gate and any field-specific rule) — the optimistic update is a display convenience, never an authorization shortcut. A cell that is not editable for the current user renders as read-only with a tooltip naming the reason. Then adopt it in at least: the leads table, the deals table, the task board card, the lead detail modal, and the company block. Provide a Playwright test proving a rejected edit reverts and explains itself.

2. SKELETON AND LOADING STATES. A skeleton primitive matching the design tokens (shimmer that respects reduced motion), plus per-surface skeletons for: leads table, pipeline board, deals board, task board, inbox thread list, prospector results, analytics cards, audit report, content hub. Rules: a surface with known layout shows a skeleton, never a spinner; anything that can arrive progressively renders progressively rather than blocking (audit results and Claude streaming already do this — make it the standard); any action taking over 400ms shows in-place progress on the control that triggered it, not a global overlay. Add a slow-network Playwright check that asserts no layout shift when real content replaces a skeleton.

3. UNIFIED TOAST AND UNDO LAYER. One toast provider with a queue (max 3 visible, stacking, auto-dismiss 5s, hover pauses, dismissible, screen-reader announced via aria-live). Variants: success, error, info, and undoable. The undoable variant carries a 6-second countdown and an Undo action implemented as a SERVER-SIDE inverse operation, not a client illusion — reuse and generalize the existing undo implementations rather than adding a parallel one, and make the inverse operation a typed contract so every new destructive action must declare either an inverse or an explicit reason it cannot be undone. Wire it to: stage and status moves, task completion, bulk actions, archive/delete, Not-now moves, merges (linking to the existing 30-day revert), and content status changes. Concurrent-edit conflicts decline the undo with a clear message. Both the action and its undo write audit entries.

4. MOTION AND ACCESSIBILITY PASS. Honor prefers-reduced-motion globally (a single CSS layer plus a hook for JS-driven animation) — today only one file does. Audit and fix: visible focus rings on every interactive element, focus trapping and restoration in modals and drawers, aria-live regions for async results, keyboard operability of the kanban boards (move a card with keyboard alone), color contrast against the dark canvas at AA for body text, and labels on every icon-only button. Report a before/after list of violations found with axe on the six busiest screens.

5. VIEW STATE IN THE URL. Filters, sort, grouping, pagination cursor, selected tab, and the open detail item must live in the URL query string on every list and board surface, so a view can be shared, bookmarked and restored on reload or back-navigation. Implement as one hook with typed schemas per surface; keep URLs readable (short keys, omit defaults). Back and forward must move through view states predictably, and opening a detail item then closing it must return to the exact prior scroll and selection.

6. DENSITY TOGGLE. A comfortable/compact switch persisted per user (not per device), affecting row height, padding and font-size steps on tables and boards through design tokens rather than per-component overrides. Compact must remain touch-legal on mobile (44px targets) — if a surface cannot honor compact on small screens, it stays comfortable there and says nothing about it.

VERIFICATION: axe report before/after; a rejected inline edit reverts with explanation; an undoable bulk action restores fully via the server inverse; a shared URL reproduces filters, sort and open item exactly; reduced-motion disables shimmer and card animations; density persists across devices for the same user. Run the full suite, typecheck and lint.
```

---

## P17 — Navigáció, tömeges műveletek, üres állapotok

```
Three navigation and consistency items building on the P16 layer. One commit each.

1. BULK ACTIONS EVERYWHERE THEY ARE MISSING. Bulk selection currently exists on 7 surfaces. Extend the same pattern — select-all-matching (not just the visible page), a persistent action bar showing the selected count, server-side batched execution with a progress indicator and a per-row result report — to: the task board and task lists (complete, assign, set priority, move to section, add tag, set due date, delete), prospector results (add as leads, run audits, dismiss), the inbox (mark read, link to lead, archive), content hub (change status where permitted), and campaign audiences (remove recipients). Rules that must hold everywhere: partial failures are reported per row and never silently swallowed; every per-row rule still applies individually (the score gate on stage changes, grants on documents, dependency rules on task completion) with skipped rows listed and the reason given; bulk actions are undoable through the P16 layer where an inverse exists.

2. RECENTS AND FAVOURITES. Track per-user recently opened entities (leads, companies, deals, tasks, boards, documents, audits) with a capped rolling history, and let anything be starred. Surfaces: the ⌘K palette shows recents on an empty query and ranks favourites first in results; the sidebar gains a collapsible Favourites section (drag to reorder, per-user); each entity header gets a star toggle. Keep it fast — recents must never add a query to the critical render path; store per user, scoped per workspace, and clear on membership removal.

3. EMPTY, ERROR AND ZERO-RESULT STATES, MADE CONSISTENT. 38 files reference "empty" with no shared pattern. Build one <StateCard> primitive with three modes — empty (nothing here yet), zero-results (filters matched nothing), error (something failed) — each taking an illustration slot, a lowercase Bricolage headline, one sentence, and a primary action. Then write the actual copy for every surface: what this module does in one line, and the single next step, with the button that performs it. Zero-result states must offer to clear the filters that caused it. Error states must offer retry and, where relevant, a link to what to check. Also add the first-run experience: a per-user dismissible "getting started" checklist on the Dashboard (install the extension, capture the first lead, run the first audit, book the first meeting, write the first post) that disappears when complete, and the guided tour steps for anything added since it was written.

VERIFICATION: a bulk stage change on 50+ leads reports skipped rows with reasons and is undoable; recents survive a reload and are workspace-scoped; every list surface has all three state modes and none shows a bare "No data"; the getting-started checklist completes and disappears. Run the full suite, typecheck and lint.
```

---

## P18 — Task: My Work és board-nézetek

```
Two task views that use the existing model — no schema changes beyond what is stated. Read src/modules/tasks/ first: boards, sections, sparse positions (steps of 1024), subtasks that never cascade completion, dependencies, recurrence that spawns a successor on completion, and templates already exist. Do not duplicate any of that. One commit per numbered item.

1. "MY WORK" — the cross-board personal view. A single screen aggregating everything assigned to the current user across all boards PLUS the loose, system-generated tasks that carry no board (follow-ups raised from leads, signal-suggested calls, callback reminders) — the model already allows boardId to be null and that must keep working. Layout: sections for Overdue, Today, This week, Later, and No date, with drag between sections rewriting the due date (dragging into Today sets today, into Later clears or pushes a week — make the rule explicit in the UI). Each row shows: title, board chip or "loose" marker, linked entity (lead/company/deal) as a clickable chip, priority, tags, subtask progress, blocked indicator when a dependency is unmet, and the source when the system created it ("raised from a signal") so the person's own work is distinguishable from ours. Inline complete, inline reschedule, inline reassign via the P16 primitive. Grouping toggle: by due bucket (default), by board, by priority, or by linked entity. This view is also where the Today Queue's task items should link to — reconcile the two so they never disagree about what is due; if Today Queue and My Work compute due-ness differently, unify on one function.

2. BOARD GROUPING AND SAVED VIEWS. On task boards, allow grouping the columns by something other than section: assignee, priority, due bucket, or tag — the same "group by" capability Monday-style boards have. Grouping is a view concern only; it must never rewrite sectionId, and dragging between groups sets the grouped attribute instead of the position (dragging a card into the "High" group sets priority high; into an assignee column reassigns). When grouped by section (the default) dragging behaves exactly as today. Then extend the existing SavedView model to task boards: a saved view captures board, grouping, filters (assignee, priority, tag, due range, completion state, blocked state), sort and column visibility, is personal or workspace-shared, and appears as tabs above the board. Reuse the SavedView infrastructure built for leads rather than adding a second one — if its shape does not fit, extend it and migrate, do not fork it.

VERIFICATION: a loose task with no board appears in My Work and completing it there behaves identically to completing it from the lead; dragging a task from Later to Today sets today's date and the change is undoable; grouping by priority and dragging a card sets priority without touching sectionId; a shared saved view is visible to the other user and reproduces filters exactly; Today Queue and My Work agree on what is due for the same fixture data. Run the full suite, typecheck and lint.
```

---

## P19 — Task: idő-nézetek

```
Three time-based task views. The model already carries startAt and dueAt, dependencies (TaskDependency), and subtasks — build on them, do not add scheduling fields without stating why. One commit per numbered item; item 1 is the largest, plan it before coding.

1. TIMELINE (GANTT) VIEW. A horizontal time view of a board (and optionally of My Work) where each task renders as a bar from startAt to dueAt; tasks with only a due date render as a milestone marker rather than a fake bar — never invent a start date. Interactions: drag a bar to shift both dates, drag either edge to resize, and drag a marker to move the due date; all with snap-to-day, live tooltip, and the P16 undo. Dependencies render as arrows between bars, drawn from the existing TaskDependency records; creating a dependency by dragging from one bar's edge to another is allowed, and creating a cycle must be refused with a clear message naming the cycle. Scheduling intelligence, kept honest and optional: when a task moves, compute which dependent tasks would now start before their blocker ends and show them highlighted with a "shift dependents" action the user must confirm — never cascade silently. Zoom levels day/week/month with a today marker and weekend shading; virtualized rendering so a board with hundreds of tasks stays smooth; horizontal scroll with keyboard support. Subtasks collapse under their parent. Read-only fallback on narrow screens (below ~900px show a compact list with date ranges rather than a cramped timeline).

2. CALENDAR VIEW. Month and week views of tasks by due date, with drag to reschedule (and, in week view, drag to set a start-to-due span). Overlay toggle for meetings from the Meetings module and for callbacks from Calls, so one screen answers "what does this week actually contain" — clearly distinguished visually and individually toggleable. Clicking a day creates a task pre-dated to it; clicking an item opens the detail. Respect the same grouping/filter set as the board views and reuse the saved views from P18. Week view should show unscheduled tasks in a side rail that can be dragged onto a day.

3. WORKLOAD VIEW. Per-assignee capacity across a chosen date range: a row per member showing tasks laid out over time, with a per-day or per-week load indicator. Load is computed from estimates if present (P20 item 1) and otherwise from a simple task count with a configurable "tasks per day" assumption stated openly in the UI — do not present a count-based estimate as if it were hours. Highlight overload against the threshold, show unassigned work in its own row so it cannot be forgotten, and allow reassignment by dragging a task from one row to another. Include team grouping when Teams exist. Keep it read-honest: the header states the assumption in use and links to where it is configured.

VERIFICATION: a task with only a due date renders as a marker and never gains an invented start date; dragging a blocker later surfaces the affected dependents and only shifts them on confirmation; a dependency cycle is refused by name; calendar drag reschedules and is undoable; the meetings overlay can be toggled off; workload shows unassigned work and states its assumption; timeline stays responsive with 500 seeded tasks. Run the full suite, typecheck and lint.
```

---

## P20 — Task: képességek

```
Six task capabilities. Several extend systems that already exist elsewhere in the codebase — reuse them rather than building parallels. One commit per numbered item.

1. ESTIMATES AND TIME TRACKING. Add an optional estimate (in hours, decimal) and actual time to Task. Time entry two ways: a running timer (start/stop, one running timer per user at a time, resumable, survives reload) and manual entry with a date and note. Roll-ups: a parent's estimate can be entered directly OR computed from subtasks — show both and mark which is in use; boards and My Work show estimate vs actual where present. Reporting: per project/board, estimate vs actual with variance, and per person a weekly time summary. This exists primarily to answer "what does a website project actually cost us" for the post-sale project module — so wire the project milestones (settings-project-templates) to carry estimates too, and surface project-level totals on the project view. Time data must be per workspace, exportable, and included in the member-removal impact report.

2. CUSTOM FIELDS ON TASKS. Extend the existing CustomField system (already serving leads, companies and deals) to tasks — do not create a second field system. Field definitions become entity-scoped; task fields render on the task detail, are usable in board grouping and filters from P18, appear as optional columns in list views, and are included in exports. Respect the existing archived-field behavior and the GDPR handling already implemented for custom field values.

3. LIGHTWEIGHT CHECKLISTS. A checklist on a task: ordered items with a checked state and free text, no assignee, no due date — deliberately lighter than subtasks, which remain the full objects they are. Progress shows as "3/7" on cards. Explain the distinction in the UI copy in one line so the choice is obvious ("checklist for steps within this task, subtask for work someone else may own"). Checklist items can be promoted to a real subtask in one action when they turn out to be bigger. Checklists must not affect completion rules: ticking every item does not complete the task.

4. BIDIRECTIONAL ENTITY LINKING. Tasks already carry entityType/entityId. Make the reverse direction first-class: every lead, company, deal and project shows its open and recently completed tasks in a dedicated panel, with inline create ("add task for this lead" pre-linked), inline complete, and a count badge on the entity header. Clicking through preserves context so returning lands where you left. Also allow linking a task to MORE than one entity where it genuinely spans them (a task tied to both a deal and its company) — implement as a join table rather than widening the existing columns, keep the single-entity fast path intact, and migrate existing links without loss.

5. BOARD AUTOMATIONS. Extend the existing WorkflowRule engine (settings-workflows) to tasks — do not build a second automation system. Triggers: task created on a board, moved to a section, completed, becomes overdue by N days, priority changed, assignee changed, all filterable by board/section/tag/priority. Actions: set priority, set due date by offset, assign to a person or team, add or remove tags, move to a section, create a follow-up task from a template, notify a user or team, and — with the existing hard rule intact — create an email DRAFT that a human must send, never an automated send. Per-board and per-workspace rules, an execution log showing what fired on what with the result, a per-rule kill switch, cycle protection (a rule's action cannot re-trigger itself; cap chained executions per originating event), and a rule limit that fails loudly rather than degrading silently.

6. COLLABORATORS AND DELEGATION. Keep assigneeId as the single accountable owner — do not turn it into an array, because "everyone is responsible" is how tasks die. Instead add: collaborators (a set of members who are working on it, distinct from followers who merely watch), and a delegation record (delegatedBy, delegatedAt) set when a task is reassigned so the trail shows who handed it over. Assignee pickers show collaborators separately; My Work shows tasks where you are the assignee by default with a toggle to include tasks where you are a collaborator. Notifications distinguish the three relationships. Reassignment writes a MembershipEvent-style entry on the task activity.

VERIFICATION: a running timer survives reload and only one runs per user; parent estimate computed from subtasks matches a hand-checked fixture and the UI states which mode is in use; a task custom field is filterable in board grouping and appears in the export; a checklist reaching 7/7 does not complete the task; a task linked to two entities appears in both panels and the single-entity fast path still works; an automation that would loop is blocked by cycle protection and logged; an email action produces a draft that requires human send; reassignment records the delegation trail. Run the full suite, typecheck and lint, then update docs/spec.md with the task module's full capability set and docs/HANDBOOK.md with anything Owner-facing (automations, estimates configuration).
```

---

## Megjegyzések a sorrendhez

A **P16** azért az első, mert a P17–P20 mind használja: az inline szerkesztés, a toast/undo réteg és az URL-állapot nélkül minden későbbi képernyő ismét saját megoldást hozna, és megint szétdriftelne.

A **P19/1 (Timeline)** a legnagyobb egyedi tétel a csomagban — érdemes külön napon kiadni, és a prompt kifejezetten kéri, hogy tervezzen kódolás előtt.

A **P20/1 (becslés és időkövetés)** üzletileg többet ér, mint amennyire task-funkciónak látszik: ez fogja megmondani, mennyibe kerül valójában egy weboldal-projekt — az árazási intelligenciád (P14) ebből tud igazán pontos lenni.
