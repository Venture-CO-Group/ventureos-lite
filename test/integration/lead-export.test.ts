import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import ExcelJS from "exceljs";
import { prismaUnsafe } from "../../src/lib/db";
import { csvCell, parseCsv } from "../helpers/csv";

/**
 * The export, end to end, against the real database.
 *
 * The formats themselves are proved in test/unit/lead-export-formats.test.ts
 * from fixtures. What can only be proved here is everything AROUND them: that
 * the rows are the filtered rows and no others, that the tenant guard still
 * holds when ids from another workspace are handed in deliberately, that the
 * whole record actually loads out of the schema rather than out of a fixture,
 * and that a route personal data leaves by writes a line saying so.
 *
 * And one negative that matters more than it looks: exporting must not call
 * Claude. The person summary is a Claude-written field, and an export that
 * quietly generated the missing ones would turn a button somebody presses
 * twice a day into an unbudgeted bill (CLAUDE.md rule #3). `ClaudeUsage` is
 * the ledger every call is written to, so its row count is the assertion.
 */
const WS = ["Export Alpha", "Export Bravo"];
const EMAIL = "export-owner@iso.test";
let wsA = "";
let wsB = "";
let ownerId = "";
let bLeadId = "";

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: (f: unknown) => f,
}));
vi.mock("@/lib/session", () => ({
  getActiveContext: async () => ({ workspaceId: wsA, userId: ownerId, sessionId: "s" }),
  tryGetActiveContext: async () => ({ workspaceId: wsA, userId: ownerId, sessionId: "s" }),
}));

const { bulkExport } = await import("../../src/modules/leads/bulk-actions");
const { exportLeadsCsv, loadLeadsForExport, resolveSelection } = await import(
  "../../src/modules/leads/bulk-store"
);
const { describeFilters } = await import("../../src/modules/leads/filters");
type FilterSet = import("../../src/modules/leads/filters").FilterSet;

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: WS } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    for (const t of [
      "message",
      "emailLog",
      "call",
      "activity",
      "auditLog",
      "claudeUsage",
      "auditResult",
      "registryData",
      "lead",
      "company",
    ] as const) {
      // @ts-expect-error dynamic model access
      await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
    }
    await prismaUnsafe.membership.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: EMAIL } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: WS[0]! } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: WS[1]! } })).id;
  ownerId = (
    await prismaUnsafe.user.create({
      data: { email: EMAIL, name: "Export Owner", passwordHash: "x" },
    })
  ).id;
  await prismaUnsafe.membership.create({
    data: { workspaceId: wsA, userId: ownerId, role: "OWNER" },
  });

  const cB = await prismaUnsafe.company.create({ data: { workspaceId: wsB, name: "Bravo Co" } });
  bLeadId = (
    await prismaUnsafe.lead.create({
      data: {
        workspaceId: wsB,
        companyId: cB.id,
        contactName: "Bravo Secret",
        personBrief: "Bravo's private brief",
      },
    })
  ).id;
});

afterAll(clean);

/**
 * One fully-enriched lead and one bare one.
 *
 * The enriched lead exercises every join the export makes — company, registry
 * adószám, a finished audit, an outbound message — and the bare one exercises
 * every one of them being absent, which is the case that used to print "null".
 */
async function seed() {
  for (const t of [
    "message",
    "emailLog",
    "call",
    "auditResult",
    "registryData",
    "lead",
    "company",
    "auditLog",
    "claudeUsage",
  ] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: wsA } });
  }

  const company = await prismaUnsafe.company.create({
    data: {
      workspaceId: wsA,
      name: "Danubia Kft",
      domain: "danubia.hu",
      city: "Budapest",
      industry: "Vendéglátás",
      taxId: "12345678-2-42",
    },
  });
  await prismaUnsafe.registryData.create({
    data: { workspaceId: wsA, companyId: company.id, taxId: "87654321-2-41" },
  });
  await prismaUnsafe.auditResult.create({
    data: {
      workspaceId: wsA,
      companyId: company.id,
      url: "https://danubia.hu",
      status: "done",
      score: 62,
      createdAt: new Date("2026-08-03T09:00:00Z"),
      expiresAt: new Date("2027-08-03T09:00:00Z"),
    },
  });
  // An older audit, to prove the export takes the latest and not the first.
  await prismaUnsafe.auditResult.create({
    data: {
      workspaceId: wsA,
      companyId: company.id,
      url: "https://danubia.hu",
      status: "done",
      score: 20,
      createdAt: new Date("2026-05-01T09:00:00Z"),
      expiresAt: new Date("2027-05-01T09:00:00Z"),
    },
  });

  const rich = await prismaUnsafe.lead.create({
    data: {
      workspaceId: wsA,
      companyId: company.id,
      contactName: "Nagy Anna",
      title: "Ügyvezető",
      email: "anna@danubia.hu",
      phone: "+36 1 234 5678",
      linkedinUrl: "https://linkedin.com/in/nagyanna",
      icpScore: 5,
      scoreBreakdown: { segment_fit: 1, decision_maker: 1, trigger_signal: 0 },
      stage: "QUALIFIED",
      signals: ["hiring", "outdated website"],
      source: "PROSPECTOR",
      ownerId,
      personBrief: 'Runs "Danubia, Kft".\nSecond line, with a comma.',
      notes: "Called twice.",
      lastActivityAt: new Date("2026-08-01T10:00:00Z"),
    },
  });
  await prismaUnsafe.message.create({
    data: {
      workspaceId: wsA,
      leadId: rich.id,
      direction: "OUTBOUND",
      body: "Hello",
      sentAt: new Date("2026-08-09T10:00:00Z"),
    },
  });
  // An inbound reply, LATER than the outbound one: "last contacted" must not
  // move because they answered us.
  await prismaUnsafe.message.create({
    data: {
      workspaceId: wsA,
      leadId: rich.id,
      direction: "INBOUND",
      body: "Hi back",
      sentAt: new Date("2026-08-20T10:00:00Z"),
    },
  });

  const bare = await prismaUnsafe.lead.create({
    data: { workspaceId: wsA, contactName: "Bare Béla", icpScore: 1, stage: "RESEARCHED" },
  });

  return { rich: rich.id, bare: bare.id };
}

beforeEach(seed);

describe("what an export carries", () => {
  it("loads the whole record, joins included", async () => {
    const ids = await seed();
    const { leads } = await loadLeadsForExport(wsA, [ids.rich]);
    expect(leads).toHaveLength(1);

    expect(leads[0]).toMatchObject({
      contactName: "Nagy Anna",
      title: "Ügyvezető",
      company: "Danubia Kft",
      email: "anna@danubia.hu",
      linkedinUrl: "https://linkedin.com/in/nagyanna",
      domain: "danubia.hu",
      city: "Budapest",
      // The registry value is the enriched one and outranks the typed one.
      taxId: "87654321-2-41",
      icpScore: 5,
      ownerName: "Export Owner",
      // The LATEST finished audit, not the first.
      auditScore: 62,
      notes: "Called twice.",
    });
    // Derived from the outbound message, not from the later inbound reply.
    expect(new Date(leads[0]!.lastContactedAt!).toISOString()).toBe("2026-08-09T10:00:00.000Z");
  });

  it("writes empty cells for a lead that has none of it", async () => {
    const ids = await seed();
    const csv = await exportLeadsCsv(wsA, [ids.bare]);
    for (const label of [
      "Company",
      "Email",
      "Phone",
      "LinkedIn URL",
      "Website",
      "Tax number",
      "Audit score",
      "Audit date",
      "Person summary",
      "Last contacted",
      "Notes",
    ]) {
      expect(csvCell(csv, label), `${label} is not empty`).toBe("");
    }
    expect(csv).not.toContain("null");
    expect(csv).not.toContain("undefined");
  });

  it("spells the score breakdown out rather than dumping JSON", async () => {
    const ids = await seed();
    const csv = await exportLeadsCsv(wsA, [ids.rich]);
    const cell = csvCell(csv, "Score breakdown");
    expect(cell).toContain("Segment fit: yes");
    expect(cell).toContain("Trigger signal: no");
    expect(cell).not.toContain("{");
  });

  it("round-trips a summary with commas, quotes and newlines out of the database", async () => {
    const ids = await seed();
    const csv = await exportLeadsCsv(wsA, [ids.rich]);
    expect(csvCell(csv, "Person summary")).toBe(
      'Runs "Danubia, Kft".\nSecond line, with a comma.',
    );
    // One lead in, one row out — the newline did not split it.
    expect(parseCsv(csv)).toHaveLength(2);
  });

  it("never exports a lead from another workspace", async () => {
    const csv = await exportLeadsCsv(wsA, [bLeadId]);
    expect(csv).not.toContain("Bravo Secret");
    expect(csv).not.toContain("Bravo's private brief");
    expect(parseCsv(csv)).toHaveLength(1);
  });
});

describe("a filtered export", () => {
  const QUALIFIED: FilterSet = {
    match: "all",
    conditions: [{ field: "stage", operator: "is", value: "QUALIFIED" }],
  };

  it("contains exactly the filtered rows", async () => {
    const ids = await seed();
    const selected = await resolveSelection(wsA, QUALIFIED);
    expect(selected).toEqual([ids.rich]);

    const csv = await exportLeadsCsv(wsA, selected);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(csvCell(csv, "Name")).toBe("Nagy Anna");
    expect(csv).not.toContain("Bare Béla");
  });

  it("names the filters that produced it", () => {
    expect(describeFilters(QUALIFIED)).toBe("Stage is QUALIFIED");
    expect(describeFilters({ match: "all", conditions: [] })).toContain("No filters");
    expect(
      describeFilters({
        match: "any",
        conditions: [
          { field: "stage", operator: "is", value: "QUALIFIED" },
          { field: "hasEmail", operator: "is_true" },
        ],
      }),
    ).toBe("Stage is QUALIFIED or Has email: yes");
  });

  it("carries the filter statement onto the spreadsheet and into the log", async () => {
    const ids = await seed();
    const res = await bulkExport({
      ids: [ids.rich],
      format: "xlsx",
      filterSummary: describeFilters(QUALIFIED),
    });
    expect(res.ok).toBe(true);

    const log = await prismaUnsafe.auditLog.findFirst({
      where: { workspaceId: wsA, action: "export.run" },
      orderBy: { at: "desc" },
    });
    expect((log?.meta as { filters?: string })?.filters).toBe("Stage is QUALIFIED");
  });
});

describe("the audit log", () => {
  it("records who exported, how many rows and in which format", async () => {
    const ids = await seed();
    const res = await bulkExport({ ids: [ids.rich, ids.bare], format: "csv" });
    expect(res.ok).toBe(true);

    const logs = await prismaUnsafe.auditLog.findMany({
      where: { workspaceId: wsA, action: "export.run" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.actorUserId).toBe(ownerId);
    expect(logs[0]!.meta).toMatchObject({ format: "csv", rows: 2, kind: "leads.csv" });
  });

  it("writes one line per export, for each format", async () => {
    const ids = await seed();
    await bulkExport({ ids: [ids.rich], format: "csv" });
    await bulkExport({ ids: [ids.rich], format: "xlsx" });

    const logs = await prismaUnsafe.auditLog.findMany({
      where: { workspaceId: wsA, action: "export.run" },
    });
    expect(logs.map((l) => (l.meta as { format: string }).format).sort()).toEqual(["csv", "xlsx"]);
  });
});

describe("Claude is not called", () => {
  it("exports a lead with no summary without generating one", async () => {
    const ids = await seed();
    const before = await prismaUnsafe.claudeUsage.count({ where: { workspaceId: wsA } });

    const csv = await exportLeadsCsv(wsA, [ids.bare]);
    expect(csvCell(csv, "Person summary")).toBe("");

    // The ledger every Claude call is written to. Unchanged means no call was
    // made — and the lead still has no brief afterwards.
    expect(await prismaUnsafe.claudeUsage.count({ where: { workspaceId: wsA } })).toBe(before);
    const after = await prismaUnsafe.lead.findUnique({ where: { id: ids.bare } });
    expect(after?.personBrief).toBeNull();
  });

  it("makes no call for any format, on a mixed selection", async () => {
    const ids = await seed();
    const before = await prismaUnsafe.claudeUsage.count({ where: { workspaceId: wsA } });

    await bulkExport({ ids: [ids.rich, ids.bare], format: "csv" });
    await bulkExport({ ids: [ids.rich, ids.bare], format: "xlsx" });

    expect(await prismaUnsafe.claudeUsage.count({ where: { workspaceId: wsA } })).toBe(before);
  });
});

describe("the spreadsheet, built from real rows", () => {
  it("types the score and the dates, and links the URLs", async () => {
    const ids = await seed();
    const res = await bulkExport({ ids: [ids.rich], format: "xlsx" });
    if (!res.ok || res.kind !== "inline") throw new Error("expected an inline xlsx");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      Buffer.from(res.base64, "base64") as unknown as Parameters<ExcelJS.Xlsx["load"]>[0],
    );
    const sheet = wb.worksheets[0]!;
    const header = sheet.getRow(1);
    const col = (label: string) => {
      for (let i = 1; i <= header.cellCount; i += 1) {
        if (header.getCell(i).text === label) return i;
      }
      throw new Error(`no column named ${label}`);
    };

    const row = sheet.getRow(2);
    expect(row.getCell(col("Name")).text).toBe("Nagy Anna");
    expect(typeof row.getCell(col("ICP score")).value).toBe("number");
    expect(typeof row.getCell(col("Audit score")).value).toBe("number");
    expect(row.getCell(col("Audit date")).value).toBeInstanceOf(Date);
    expect(row.getCell(col("LinkedIn URL")).value).toMatchObject({
      hyperlink: "https://linkedin.com/in/nagyanna",
    });
    expect(row.getCell(col("Website")).value).toMatchObject({
      hyperlink: "https://danubia.hu",
    });
  });
});

describe("how a big export is delivered", () => {
  it("hands a small one back inline", async () => {
    const ids = await seed();
    const res = await bulkExport({ ids: [ids.rich], format: "csv" });
    expect(res.ok && res.kind).toBe("inline");
  });

  it("writes a big one to the files volume instead of the action payload", async () => {
    const { FILE_DELIVERY_THRESHOLD } = await import("../../src/modules/leads/export-formats");
    const ids = await seed();
    // Real ids are not needed to choose the delivery: the count decides, and
    // the ids that do not resolve simply export nothing.
    const many = [
      ids.rich,
      ...Array.from({ length: FILE_DELIVERY_THRESHOLD }, (_, i) => `missing-${i}`),
    ];
    const res = await bulkExport({ ids: many, format: "csv" });
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== "file") throw new Error("expected a file delivery");

    // The prefix is what `resolveFileWorkspace` reads the owner out of; a name
    // it cannot parse is a file served to nobody.
    expect(res.rel.startsWith(`exports/${wsA}-leads-`)).toBe(true);
    expect(res.rel.endsWith(".csv")).toBe(true);

    const { readFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const abs = join(process.env.FILES_DIR ?? "/data/files", res.rel);
    const text = await readFile(abs, "utf8");
    expect(text).toContain("Nagy Anna");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    await rm(abs, { force: true });
  });
});

describe("the PDF row cap", () => {
  it("refuses a document past the cap and names the spreadsheet", async () => {
    const { MAX_PDF_ROWS } = await import("../../src/modules/leads/export-formats");
    const tooMany = Array.from({ length: MAX_PDF_ROWS + 1 }, (_, i) => `lead-${i}`);
    const res = await bulkExport({ ids: tooMany, format: "pdf" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a refusal");
    expect(res.error).toContain("Excel");

    // Refused before anything was built, so nothing was logged as exported.
    expect(
      await prismaUnsafe.auditLog.count({ where: { workspaceId: wsA, action: "export.run" } }),
    ).toBe(0);
  });
});
