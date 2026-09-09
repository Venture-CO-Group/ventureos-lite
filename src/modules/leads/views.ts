/**
 * Saved views (playbook-v2 P3/2): a named filter set + column selection + sort,
 * personal or workspace-shared, rendered as the tabs above the leads table.
 *
 * Pure rules only — visibility, editability, naming, and the mapping between a
 * stored view and the query string the table already reads. The server actions
 * in `view-actions.ts` enforce these; keeping them here means they can be
 * tested without a database and reused by the UI to hide what it must not offer.
 */

import { serializeFilterSet, serializeSort, serializeColumns } from "./view-params";
import type { FilterCondition, FilterSet, SortSpec } from "./filters";
import { isTrustedMember } from "@/lib/grants";

export interface LeadView {
  id: string;
  name: string;
  /** Who created it. A shared view still remembers whose it is. */
  ownerId: string;
  shared: boolean;
  filters: FilterSet;
  sort: SortSpec;
  columns: string[];
  position: number;
}

/** A tab a person may not see is a tab that must not reach their browser. */
/**
 * Ownership, not lead-ness.
 *
 * These two took a `LeadView` and read only `ownerId` and `shared`. Task board
 * views (playbook-v5 P18/2) live in the same table under the same rules, and
 * the alternative to widening the parameter was a second copy of the rule —
 * which is exactly how the second copy ends up subtly wrong. The `shared`
 * test below in particular was hard-won.
 */
export interface ViewOwnership {
  ownerId: string;
  shared: boolean;
}

export function canSeeView(view: ViewOwnership, userId: string): boolean {
  return view.shared || view.ownerId === userId;
}

/**
 * Seeing a shared tab is not the same as being able to redefine it under the
 * person who made it. Only the creator edits their own; a seated member may
 * curate the workspace's SHARED tabs, which is what makes them shared rather
 * than merely visible.
 *
 * The `shared` test is load-bearing and was not always here. It did not need to
 * be while curation was an Owner/Admin power: a BDR could edit nothing but
 * their own, so a colleague's personal tab was safe by accident. Widening
 * curation to every seated member removed that accident — without this line, one
 * BDR could rewrite another's private tab out from under them.
 */
export function canEditView(view: ViewOwnership, userId: string, role: string): boolean {
  if (view.ownerId === userId) return true;
  if (!view.shared) return false;
  return isTrustedMember(role);
}

export const MAX_VIEW_NAME = 60;

/** Null when there is no name left after trimming — the caller reports that. */
export function normalizeViewName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) return null;
  return name.slice(0, MAX_VIEW_NAME);
}

/** Order-independent identity for one condition. */
function conditionKey(c: FilterCondition): string {
  return JSON.stringify([
    c.field,
    c.operator,
    c.value ?? null,
    [...(c.values ?? [])].sort(),
    c.min ?? null,
    c.max ?? null,
  ]);
}

function sameFilters(a: FilterSet, b: FilterSet): boolean {
  if (a.match !== b.match) return false;
  if (a.conditions.length !== b.conditions.length) return false;
  // Condition ORDER is not something the user chose — two conditions added the
  // other way round describe the same question, and the tab should stay lit.
  const left = a.conditions.map(conditionKey).sort();
  const right = b.conditions.map(conditionKey).sort();
  return left.every((k, i) => k === right[i]);
}

/** Is the table currently showing exactly this view? Drives tab highlighting. */
export function viewMatchesState(
  view: LeadView,
  filters: FilterSet,
  sort: SortSpec,
  columns: string[],
): boolean {
  if (!sameFilters(view.filters, filters)) return false;
  if (view.sort.field !== sort.field || view.sort.direction !== sort.direction) return false;
  if (view.columns.length !== columns.length) return false;
  // Column order IS a choice, so this one compares positionally.
  return view.columns.every((c, i) => c === columns[i]);
}

/**
 * The query string that opens a view. Deliberately produces no `page`: opening
 * a tab lands on its first page, never on whatever page the previous tab was on.
 */
export function viewToQuery(view: LeadView): URLSearchParams {
  const q = new URLSearchParams();
  q.set("view", view.id);
  const f = serializeFilterSet(view.filters);
  if (f) q.set("f", f);
  q.set("sort", serializeSort(view.sort));
  q.set("cols", serializeColumns(view.columns));
  return q;
}
