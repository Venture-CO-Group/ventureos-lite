/**
 * Loading the leads table (playbook-v2 P3/2).
 *
 * One read of the workspace's leads, then filter → sort → paginate in memory.
 * `filters.ts` explains why the predicates cannot live in the `where` clause;
 * the consequence here is that `total`, `pageCount` and "select all matching"
 * are all derived from the same array and therefore cannot disagree.
 */

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { companyUnderProceedings, riskLabel } from "@/modules/registry/risk";
import { gateThresholdFromConfig } from "./scoring";
import { cached } from "@/lib/ttl-cache";
import { listFieldDefsWith } from "@/modules/fields/store";
import { readValues, type FieldDef } from "@/modules/fields/types";
import { assignableMembers } from "@/modules/members/directory";
import {
  applyFilters,
  applySort,
  paginate,
  DEFAULT_PAGE_SIZE,
  type FilterSet,
  type FilterableLead,
  type SortSpec,
} from "./filters";

export interface LeadTableRow extends FilterableLead {
  companyId: string | null;
  avatarPath: string | null;
  sizeBand: string | null;
  /** Registry proceedings chip, when the company is under one. */
  riskLabel: string | null;
  ownerName: string | null;
}

export interface WorkspaceMember {
  id: string;
  name: string;
}

/** The dropdown contents for the filter builder — real values, not guesses. */
export interface LeadFacets {
  industries: string[];
  cities: string[];
  signals: string[];
  sources: string[];
  stages: string[];
  owners: WorkspaceMember[];
}

export interface LeadTableData {
  rows: LeadTableRow[];
  page: number;
  pageCount: number;
  pageSize: number;
  /** Rows matching the filter — not rows in the workspace. */
  total: number;
  /** Rows in the workspace, so the UI can say "12 of 93". */
  totalUnfiltered: number;
  threshold: number;
  facets: LeadFacets;
  /** Owner-defined lead fields (P5/1) — columns, filters and cell rendering. */
  customFields: FieldDef[];
}

type LoadedLead = Awaited<ReturnType<typeof fetchLeads>>[number];

/**
 * The whole workspace's leads, in the shape the filter engine needs — and
 * NOTHING ELSE (P6/3).
 *
 * `filters.ts` explains why the predicates cannot live in the `where` clause,
 * so this read is unavoidably the whole workspace. What IS avoidable is what
 * each row costs: the registry join, the avatar path and the size band are
 * display-only, and joining `registry_data` 5,000 times to render 50 rows was
 * a third of the query's cost. Those three are hydrated for the page rows
 * afterwards, in `hydratePage`.
 */
async function fetchLeads(workspaceId: string) {
  const db = getWorkspaceClient(workspaceId);
  return db.lead.findMany({
    // Tombstones are not rows a person works — a merged-away lead lives on so
    // its id still resolves, not so it can clutter the table (P5/2).
    where: { mergedIntoId: null },
    select: {
      id: true,
      companyId: true,
      contactName: true,
      title: true,
      email: true,
      phone: true,
      icpScore: true,
      stage: true,
      signals: true,
      source: true,
      ownerId: true,
      lastActivityAt: true,
      createdAt: true,
      customFields: true,
      company: { select: { name: true, industry: true, city: true } },
    },
  });
}

/**
 * Fill in the display-only fields for the rows actually on screen.
 *
 * One extra query for ≤50 ids, against one avoided join across every lead in
 * the workspace. At 5,000 leads that trade is worth roughly a third of the
 * table's load time.
 */
async function hydratePage(workspaceId: string, rows: LeadTableRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getWorkspaceClient(workspaceId);
  const leads = await db.lead.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    select: {
      id: true,
      avatarPath: true,
      company: {
        select: { sizeBand: true, registry: { select: { statusFlags: true } } },
      },
    },
  });
  const byId = new Map(leads.map((l) => [l.id, l]));
  for (const row of rows) {
    const extra = byId.get(row.id);
    if (!extra) continue;
    row.avatarPath = extra.avatarPath;
    row.sizeBand = extra.company?.sizeBand ?? null;
    const flags = Array.isArray(extra.company?.registry?.statusFlags)
      ? (extra.company.registry.statusFlags as string[])
      : null;
    row.riskLabel = companyUnderProceedings(flags) ? riskLabel(flags) : null;
  }
}

function toRow(l: LoadedLead, ownerNames: Map<string, string>): LeadTableRow {
  return {
    id: l.id,
    companyId: l.companyId,
    contactName: l.contactName,
    // Display-only; filled in for the page rows by hydratePage.
    avatarPath: null,
    title: l.title,
    email: l.email,
    phone: l.phone,
    company: l.company?.name ?? null,
    industry: l.company?.industry ?? null,
    city: l.company?.city ?? null,
    sizeBand: null,
    icpScore: l.icpScore,
    stage: l.stage,
    signals: Array.isArray(l.signals) ? (l.signals as string[]) : [],
    source: l.source,
    ownerId: l.ownerId,
    ownerName: l.ownerId ? (ownerNames.get(l.ownerId) ?? null) : null,
    lastActivityAt: l.lastActivityAt,
    createdAt: l.createdAt,
    customFields: readValues(l.customFields),
    riskLabel: null,
  };
}

/**
 * Everyone who could own a lead here (§1).
 *
 * Through the directory rather than a bare `findMany`: this used to include
 * suspended people, read-only client accounts and — since the lifecycle
 * landed — pending invitations and ended memberships. Assigning a lead to
 * somebody who cannot sign in is a lead nobody works.
 */
export async function workspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const members = await assignableMembers(workspaceId);
  return members
    .map((m) => ({ id: m.id, name: m.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "hu"));
}

/**
 * The filter dropdowns' contents (P6/3).
 *
 * Cached for 60 seconds per workspace. The facets are distinct values across
 * every lead — an inherently whole-table question — and they change when
 * somebody types a new city, which is not something a dropdown has to notice
 * within the second. Caching them is what lets the common page load stop
 * reading every lead in the workspace.
 */
async function loadFacets(
  workspaceId: string,
  owners: WorkspaceMember[],
): Promise<LeadFacets> {
  return cached(`lead-facets:${workspaceId}`, async () => {
    const db = getWorkspaceClient(workspaceId);
    const rows = await db.lead.findMany({
      where: { mergedIntoId: null },
      select: {
        signals: true,
        source: true,
        stage: true,
        company: { select: { industry: true, city: true } },
      },
    });
    const uniqueSorted = (values: Array<string | null | undefined>) =>
      [...new Set(values.filter((v): v is string => !!v && v.trim().length > 0))].sort((a, b) =>
        a.localeCompare(b, "hu"),
      );
    return {
      industries: uniqueSorted(rows.map((r) => r.company?.industry)),
      cities: uniqueSorted(rows.map((r) => r.company?.city)),
      signals: uniqueSorted(
        rows.flatMap((r) => (Array.isArray(r.signals) ? (r.signals as string[]) : [])),
      ),
      sources: uniqueSorted(rows.map((r) => r.source)),
      stages: uniqueSorted(rows.map((r) => r.stage)),
      owners,
    };
  });
}

/**
 * Sort fields the database can order by directly, with the same nulls-last
 * semantics `applySort` uses. `company` and `stage` are absent on purpose:
 * ordering by a relation field cannot express nulls-last in Prisma, and stage
 * needs pipeline order rather than alphabetical.
 */
const SQL_SORTABLE: Partial<Record<SortSpec["field"], { column: string; nullable: boolean }>> = {
  contactName: { column: "contactName", nullable: true },
  icpScore: { column: "icpScore", nullable: true },
  lastActivityAt: { column: "lastActivityAt", nullable: true },
  // NOT nullable, and Prisma rejects the `{ sort, nulls }` form on a required
  // column — "Expected SortOrder, provided Object" — so it takes the plain one.
  createdAt: { column: "createdAt", nullable: false },
};

/** Distinct values actually present, so the filter never offers a dead end. */
function buildFacets(rows: LeadTableRow[], owners: WorkspaceMember[]): LeadFacets {
  const uniqueSorted = (values: Array<string | null>) =>
    [...new Set(values.filter((v): v is string => !!v && v.trim().length > 0))].sort((a, b) =>
      a.localeCompare(b, "hu"),
    );

  return {
    industries: uniqueSorted(rows.map((r) => r.industry)),
    cities: uniqueSorted(rows.map((r) => r.city)),
    signals: uniqueSorted(rows.flatMap((r) => r.signals)),
    sources: uniqueSorted(rows.map((r) => r.source)),
    stages: uniqueSorted(rows.map((r) => r.stage)),
    owners,
  };
}

export async function loadLeadsTable(
  workspaceId: string,
  opts: {
    filters: FilterSet;
    sort: SortSpec;
    page: number;
    pageSize?: number;
    now?: Date;
  },
): Promise<LeadTableData> {
  const sqlField = SQL_SORTABLE[opts.sort.field];

  /**
   * THE FAST PATH (P6/3).
   *
   * With no filter conditions and a database-sortable column — which is every
   * ordinary page load of this screen — there is no reason to read the whole
   * workspace into memory. One count and one paged query answer it, and the
   * facets come from the 60-second cache.
   *
   * The slow path below is still correct and still required: `filters.ts`
   * explains why the predicates cannot live in a `where` clause, so a filtered
   * table genuinely has to pass over every row.
   */
  if (opts.filters.conditions.length === 0 && sqlField) {
    return loadUnfilteredPage(workspaceId, opts, sqlField);
  }

  const [leads, owners, ws, customFields] = await Promise.all([
    fetchLeads(workspaceId),
    workspaceMembers(workspaceId),
    prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { icpConfig: true },
    }),
    listFieldDefsWith(getWorkspaceClient(workspaceId), "lead"),
  ]);

  const ownerNames = new Map(owners.map((o) => [o.id, o.name]));
  const all = leads.map((l) => toRow(l, ownerNames));

  const matched = applyFilters(all, opts.filters, opts.now ?? new Date(), customFields);
  const sorted = applySort(matched, opts.sort);
  const page = paginate(sorted, opts.page, opts.pageSize ?? DEFAULT_PAGE_SIZE);
  await hydratePage(workspaceId, page.rows);

  return {
    rows: page.rows,
    page: page.page,
    pageCount: page.pageCount,
    pageSize: page.pageSize,
    total: page.total,
    totalUnfiltered: all.length,
    threshold: gateThresholdFromConfig(ws?.icpConfig),
    // Facets come from ALL leads, not the filtered set: a dropdown that loses
    // its other options the moment you pick one cannot be used to change your
    // mind, which is most of what filtering is.
    facets: buildFacets(all, owners),
    customFields,
  };
}

async function loadUnfilteredPage(
  workspaceId: string,
  opts: { sort: SortSpec; page: number; pageSize?: number },
  sqlField: { column: string; nullable: boolean },
): Promise<LeadTableData> {
  const db = getWorkspaceClient(workspaceId);
  const pageSize = Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE);
  const direction = opts.sort.direction;

  const [total, owners, ws, customFields] = await Promise.all([
    db.lead.count({ where: { mergedIntoId: null } }),
    workspaceMembers(workspaceId),
    prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { icpConfig: true },
    }),
    listFieldDefsWith(db, "lead"),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page) || 1), pageCount);

  const rows = await db.lead.findMany({
    where: { mergedIntoId: null },
    // Nulls last in BOTH directions, matching applySort: "no value" is not the
    // smallest value, it is the least interesting one. The id is the tiebreak,
    // without which two equal keys can swap between pages and lose a row.
    orderBy: [
      {
        [sqlField.column]: sqlField.nullable
          ? { sort: direction, nulls: "last" }
          : direction,
      },
      { id: "asc" },
    ] as never,
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: {
      id: true,
      companyId: true,
      contactName: true,
      title: true,
      email: true,
      phone: true,
      icpScore: true,
      stage: true,
      signals: true,
      source: true,
      ownerId: true,
      lastActivityAt: true,
      createdAt: true,
      customFields: true,
      company: { select: { name: true, industry: true, city: true } },
    },
  });

  const ownerNames = new Map(owners.map((o) => [o.id, o.name]));
  const pageRows = rows.map((l) => toRow(l, ownerNames));
  await hydratePage(workspaceId, pageRows);

  return {
    rows: pageRows,
    page,
    pageCount,
    pageSize,
    total,
    totalUnfiltered: total,
    threshold: gateThresholdFromConfig(ws?.icpConfig),
    facets: await loadFacets(workspaceId, owners),
    customFields,
  };
}

/**
 * Every lead id matching a filter set, for a bulk action that was launched with
 * "select all matching" rather than with ticked checkboxes. Recomputed
 * server-side from the filter rather than trusted from the client — the browser
 * may not decide which rows a mutation touches.
 */
export async function matchingLeadIds(
  workspaceId: string,
  filters: FilterSet,
  now: Date = new Date(),
): Promise<string[]> {
  const [leads, customFields] = await Promise.all([
    fetchLeads(workspaceId),
    listFieldDefsWith(getWorkspaceClient(workspaceId), "lead"),
  ]);
  const rows = leads.map((l) => toRow(l, new Map()));
  return applyFilters(rows, filters, now, customFields).map((r) => r.id);
}
