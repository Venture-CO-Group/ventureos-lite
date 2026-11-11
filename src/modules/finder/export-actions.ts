"use server";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant, isOwner } from "@/lib/authz";
import { describeCriteria, parseCriteria } from "./criteria";
import { DEFAULT_COLUMN_KEYS, pickColumns } from "./export-columns";
import { buildFinderCsv, buildFinderXlsx } from "./export";
import { loadFinderRows } from "./rows-load";

/**
 * Exporting Company Finder results (item 6). Gated on `exports.run` and
 * audit-logged BEFORE the file is built (hard rule 8) — the row count,
 * columns, format and the list's definition. Bank account numbers leave only
 * with an Owner's explicit toggle, checked here, not in the dialog.
 */
export type FinderExportResult =
  | { ok: true; kind: "inline"; filename: string; mime: string; base64: string; rows: number }
  | { ok: true; kind: "file"; rel: string; rows: number }
  | { ok: false; error: string };

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";
/** Above this many rows the file goes to the files volume instead of the action payload. */
const FILE_THRESHOLD = 1000;

const input = z.object({
  listId: z.string().min(1),
  format: z.enum(["csv", "xlsx"]),
  columns: z.array(z.string().min(1)).max(100).default([...DEFAULT_COLUMN_KEYS]),
  /** Omitted → the full result set. */
  ids: z.array(z.string().min(1)).max(20_000).optional(),
  scope: z.enum(["all", "view", "selection"]).default("all"),
  includeBankAccounts: z.boolean().default(false),
  purpose: z.string().trim().max(500).optional(),
});

export async function exportFinderResults(raw: unknown): Promise<FinderExportResult> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Pick a format and at least one column." };
  const p = parsed.data;
  if (!(await hasGrant("exports.run"))) return { ok: false, error: "You need the exports.run grant to export." };

  const cols = pickColumns(p.columns);
  if (cols.length === 0) return { ok: false, error: "Pick at least one column." };
  const wantsBank = cols.some((c) => c.ownerOnly);
  const owner = await isOwner();
  if (wantsBank && !(owner && p.includeBankAccounts)) {
    return { ok: false, error: "Bank account numbers can only be exported by the Owner, with the explicit toggle on." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const list = await db.finderList.findUnique({ where: { id: p.listId } });
  if (!list) return { ok: false, error: "That list no longer exists." };
  const rows = await loadFinderRows(db, list.id, { ids: p.ids, withBank: wantsBank });
  if (rows.length === 0) return { ok: false, error: "Nothing to export." };

  const stamp = new Date();
  const criteria = parseCriteria(list.criteria);
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "export.run",
      entityType: "FinderList",
      entityId: list.id,
      meta: {
        kind: `finder.${p.format}`,
        format: p.format,
        rows: rows.length,
        scope: p.scope,
        columns: cols.map((c) => c.key),
        bankAccounts: wantsBank,
        list: { name: list.name, cachedOnly: list.cachedOnly, summary: describeCriteria(criteria), criteria },
      },
    },
  });

  const ws = await prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
  const safe = list.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "companies";
  const date = stamp.toISOString().slice(0, 10);
  const buf =
    p.format === "csv"
      ? buildFinderCsv(rows, cols)
      : await buildFinderXlsx(rows, cols, { listName: list.name, exportedAt: stamp, workspaceName: ws?.name ?? "Company Finder" });
  const mime = p.format === "csv" ? "text/csv;charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  if (rows.length > FILE_THRESHOLD) {
    // The name must start `<workspaceId>-`: the authenticated files route reads the owner out of it.
    const rel = `exports/${workspaceId}-finder-${stamp.getTime()}.${p.format}`;
    const abs = join(FILES_DIR, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    return { ok: true, kind: "file", rel, rows: rows.length };
  }
  return { ok: true, kind: "inline", filename: `${safe}-${date}.${p.format}`, mime, base64: buf.toString("base64"), rows: rows.length };
}
