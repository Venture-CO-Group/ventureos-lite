import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import ExcelJS from "exceljs";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { saveList } from "../../src/modules/finder/store";
import { advanceFinderRun, createFinderRun, estimateEnrichment, harvestList } from "../../src/modules/finder/engine";
import { parseCsv } from "../../src/modules/finder/export";
import { DEFAULT_COLUMN_KEYS } from "../../src/modules/finder/export-columns";
import { fixtureApi } from "../helpers/cegadat-fixtures";

/**
 * The Company Finder export through its server action (items 6–7): the grant,
 * the Owner-only bank-account toggle, the column picker, the CSV round trip
 * of Hungarian accents and commas, the typed XLSX, and the audit entry every
 * export writes.
 */
const WS = "Company Finder Export";
let wsId = "";
let listId = "";
const NOW = new Date("2026-11-30T09:00:00Z");
const who = { owner: true, grants: true };

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/session", () => ({
  getActiveContext: async () => ({ workspaceId: wsId, userId: "user-export", sessionId: "s", role: who.owner ? "OWNER" : "BDR" }),
  tryGetActiveContext: async () => ({ workspaceId: wsId, userId: "user-export", sessionId: "s", role: who.owner ? "OWNER" : "BDR" }),
}));
vi.mock("@/lib/authz", () => ({
  hasGrant: async () => who.grants,
  requireGrant: async () => {
    if (!who.grants) throw new Error("forbidden");
  },
  isOwner: async () => who.owner,
  requireOwner: async () => {
    if (!who.owner) throw new Error("forbidden");
  },
}));

const { exportFinderResults } = await import("../../src/modules/finder/export-actions");

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: WS }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of ["finderResult", "finderRun", "finderList", "candidatePool", "harvestProgress", "registryQuotaLedger", "registrySheet", "registrySearchCache", "auditLog", "segment"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  wsId = (await prismaUnsafe.workspace.create({ data: { name: WS, outboundConfig: { registry: { monthlyLimit: 1000, reservePct: 0 } } } })).id;
  const db = getWorkspaceClient(wsId);
  const res = await saveList(db, wsId, { name: "Budapest, all sizes", criteria: { keywords: ["Társaság"], counties: ["Budapest"] } }, null);
  if (!res.ok) throw new Error(res.error);
  listId = res.list.id;
  const f = fixtureApi();
  const deps = { now: () => NOW, registryApi: f.api, sleep: async () => {} };
  await harvestList(wsId, listId, deps);
  const run = await createFinderRun(db, wsId, { listId, maxLookups: 20, estimate: await estimateEnrichment(wsId, listId, 20, NOW), userId: null });
  for (let i = 0; i < 10 && (await advanceFinderRun(wsId, run.id, deps)).again; i++);
});
afterAll(clean);
beforeEach(async () => {
  who.owner = true;
  who.grants = true;
  await prismaUnsafe.auditLog.deleteMany({ where: { workspaceId: wsId } });
});

function decode(res: Awaited<ReturnType<typeof exportFinderResults>>): Buffer {
  if (!res.ok || res.kind !== "inline") throw new Error(res.ok ? "expected inline" : res.error);
  return Buffer.from(res.base64, "base64");
}

describe("CSV", () => {
  it("round-trips Hungarian accents and commas in names, with a BOM and empty cells for empty values", async () => {
    const buf = decode(await exportFinderResults({ listId, format: "csv", columns: ["legalName", "shortName", "email", "employeeCount", "website", "inCrm"] }));
    const text = buf.toString("utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const [header, ...rows] = parseCsv(text).filter((r) => r.length > 1);
    // Columns come out in the registry's order, whatever order they were ticked in.
    expect(header).toEqual(["Legal name", "Short name", "Employees", "Email", "Website", "Already in CRM"]);
    const arviz = rows.find((r) => r[1] === "Árvíztűrő, Tükörfúró és Társa Kft.");
    expect(arviz).toEqual([
      "Árvíztűrő, Tükörfúró és Társa Korlátolt Felelősségű Társaság",
      "Árvíztűrő, Tükörfúró és Társa Kft.",
      "4",
      "iroda@arviztuero.example",
      "",
      "no",
    ]);
    // The raw line quotes the comma-bearing names.
    expect(text).toContain('"Árvíztűrő, Tükörfúró és Társa Kft."');
    expect(rows).toHaveLength(5);
  });

  it("exports exactly the picked columns, for the selection only", async () => {
    const db = getWorkspaceClient(wsId);
    const one = await db.finderResult.findFirst({ where: { listId, taxNumber: "32305964243" } });
    const buf = decode(await exportFinderResults({ listId, format: "csv", columns: ["taxNumber", "city"], ids: [one!.id], scope: "selection" }));
    expect(parseCsv(buf.toString("utf8")).filter((r) => r.length > 1)).toEqual([
      ["Tax number", "City"],
      ["32305964-2-43", "Budapest"],
    ]);
  });
});

describe("XLSX", () => {
  it("types numbers and dates, links websites and emails, freezes the header and turns on the filter", async () => {
    const buf = decode(await exportFinderResults({ listId, format: "xlsx", columns: [...DEFAULT_COLUMN_KEYS] }));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0]!;
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.autoFilter).toBeTruthy();
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    expect(header).toHaveLength(DEFAULT_COLUMN_KEYS.length);
    expect(header).not.toContain("Bank accounts");
    const col = (label: string) => header.indexOf(label) + 1;
    let minta = 0;
    sheet.eachRow((row, n) => {
      if (row.getCell(col("Tax number")).value === "99999999-2-42") minta = n;
    });
    const r = sheet.getRow(minta);
    expect(r.getCell(col("Net revenue (HUF)")).value).toBe(184_000_000);
    expect(r.getCell(col("Employees")).value).toBe(14);
    expect(r.getCell(col("Founded")).value).toEqual(new Date(Date.UTC(2012, 2, 1)));
    expect(r.getCell(col("Website")).value).toMatchObject({ hyperlink: "https://www.mintafogaszat.example" });
    expect(r.getCell(col("Email")).value).toMatchObject({ hyperlink: "mailto:info@mintafogaszat.example" });
    expect(r.getCell(col("Email source")).value).toBe("registry");
    expect(r.getCell(col("Already in CRM")).value).toBe(false);
  });
});

describe("restrictions and the audit trail", () => {
  it("refuses an export without the exports.run grant", async () => {
    who.grants = false;
    const res = await exportFinderResults({ listId, format: "csv" });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("exports.run") });
    expect(await prismaUnsafe.auditLog.count({ where: { workspaceId: wsId } })).toBe(0);
  });

  it("exports bank accounts only for the Owner with the explicit toggle", async () => {
    who.owner = false;
    expect(await exportFinderResults({ listId, format: "csv", columns: ["taxNumber", "bankAccounts"], includeBankAccounts: true })).toMatchObject({ ok: false });
    who.owner = true;
    expect(await exportFinderResults({ listId, format: "csv", columns: ["taxNumber", "bankAccounts"] })).toMatchObject({ ok: false });
    const buf = decode(await exportFinderResults({ listId, format: "csv", columns: ["taxNumber", "bankAccounts"], includeBankAccounts: true }));
    const rows = parseCsv(buf.toString("utf8")).filter((r) => r.length > 1);
    expect(rows.find((r) => r[0] === "32305964-2-43")![1]).toBe("00000000-00000000-00000000 OTP Fiók Tapolca; 00000000-00000000-00000000 OTP Veszprém m. Belföldiek Devizái");
    // And a default export never carries them.
    const plain = decode(await exportFinderResults({ listId, format: "csv" })).toString("utf8");
    expect(plain).not.toContain("00000000-00000000-00000000");
  });

  it("writes an audit entry for every export, with the list definition, rows, columns and format", async () => {
    await exportFinderResults({ listId, format: "csv", columns: ["taxNumber", "email"] });
    await exportFinderResults({ listId, format: "xlsx" });
    const logs = await prismaUnsafe.auditLog.findMany({ where: { workspaceId: wsId, action: "export.run" }, orderBy: { at: "asc" } });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ actorUserId: "user-export", entityType: "FinderList", entityId: listId });
    expect(logs[0]!.meta).toMatchObject({
      kind: "finder.csv",
      format: "csv",
      rows: 5,
      columns: ["taxNumber", "email"],
      bankAccounts: false,
      list: { name: "Budapest, all sizes", summary: "keywords Társaság · in Budapest" },
    });
    expect((logs[1]!.meta as { columns: string[] }).columns).toHaveLength(DEFAULT_COLUMN_KEYS.length);
  });
});
