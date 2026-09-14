import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { csvCell } from "../helpers/csv";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import {
  createFieldDef,
  getFieldValues,
  listFieldDefs,
  setFieldValues,
  updateFieldDef,
} from "../../src/modules/fields/store";
import { loadLeadsTable, matchingLeadIds } from "../../src/modules/leads/table";
import { exportLeadsCsv } from "../../src/modules/leads/bulk-store";
import { eraseLeadData } from "../../src/modules/gdpr/erase";
import { anonymizeLead } from "../../src/modules/gdpr/sweep";
import { clearCache } from "../../src/lib/ttl-cache";

/**
 * Owner-defined fields against the real database (playbook-v2 P5/1).
 *
 * The pure rules are unit-tested. What matters here is what a value can REACH:
 * the tenant guard on both the definitions and the values, the archive rule,
 * and the two places a custom value must not survive — an erasure and an
 * anonymization.
 */
const NAMES = ["Fields Alpha", "Fields Bravo"];
let wsA = "";
let wsB = "";
let companyA = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of [
    "activity",
    "auditLog",
    "customFieldDef",
    "document",
    "deal",
    "dealStage",
    "pipeline",
    "lead",
    "company",
  ] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
});

afterAll(clean);

beforeEach(async () => {
  // The duplicate scan and the table facets are cached in-process for 60s
  // (P6/3). A test rewrites the database underneath that, so it starts cold.
  clearCache();
  const ids = [wsA, wsB];
  for (const t of ["activity", "customFieldDef", "lead", "company"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  companyA = (
    await prismaUnsafe.company.create({ data: { workspaceId: wsA, name: "Danubia Kft" } })
  ).id;
});

const db = () => getWorkspaceClient(wsA);

async function lead(name = "Kovács Anna") {
  return prismaUnsafe.lead.create({
    data: { workspaceId: wsA, companyId: companyA, contactName: name },
  });
}

async function segmentField() {
  const res = await createFieldDef(wsA, null, {
    entity: "lead",
    label: "Segment",
    type: "SELECT",
    options: [
      { value: "horeca", label: "HoReCa" },
      { value: "retail", label: "Retail" },
    ],
  });
  if (!res.ok) throw new Error(res.error);
  return res.def;
}

describe("definitions", () => {
  it("derives a stable key from a Hungarian label", async () => {
    const res = await createFieldDef(wsA, null, {
      entity: "lead",
      label: "Ügyfél típusa",
      type: "TEXT",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.def.key).toBe("ugyfel_tipusa");
  });

  it("refuses a duplicate key on the same entity, but allows it on another", async () => {
    await createFieldDef(wsA, null, { entity: "lead", label: "Segment", type: "TEXT" });
    const dup = await createFieldDef(wsA, null, { entity: "lead", label: "Segment", type: "TEXT" });
    expect(dup.ok).toBe(false);

    const other = await createFieldDef(wsA, null, {
      entity: "company",
      label: "Segment",
      type: "TEXT",
    });
    expect(other.ok).toBe(true);
  });

  it("refuses a key that would shadow a built-in column", async () => {
    const res = await createFieldDef(wsA, null, { entity: "lead", label: "Stage", type: "TEXT" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/built-in/);
  });

  it("refuses a select with no options", async () => {
    const res = await createFieldDef(wsA, null, {
      entity: "lead",
      label: "Band",
      type: "SELECT",
      options: [],
    });
    expect(res.ok).toBe(false);
  });

  it("never leaks a definition into another workspace", async () => {
    await segmentField();
    expect(await listFieldDefs(wsB, "lead")).toEqual([]);
  });
});

describe("values", () => {
  it("stores a valid value and reads it back", async () => {
    const def = await segmentField();
    const l = await lead();
    const res = await setFieldValues(wsA, "lead", l.id, { [def.key]: "horeca" });
    expect(res.ok).toBe(true);
    expect(await getFieldValues(wsA, "lead", l.id)).toEqual({ segment: "horeca" });
  });

  it("refuses a value the definition does not allow", async () => {
    const def = await segmentField();
    const l = await lead();
    const res = await setFieldValues(wsA, "lead", l.id, { [def.key]: "aerospace" });
    expect(res.ok).toBe(false);
    expect(await getFieldValues(wsA, "lead", l.id)).toEqual({});
  });

  it("is partial: writing one field leaves the others alone", async () => {
    await segmentField();
    await createFieldDef(wsA, null, { entity: "lead", label: "Note", type: "TEXT" });
    const l = await lead();
    await setFieldValues(wsA, "lead", l.id, { segment: "retail", note: "keen" });
    await setFieldValues(wsA, "lead", l.id, { note: "very keen" });
    expect(await getFieldValues(wsA, "lead", l.id)).toEqual({
      segment: "retail",
      note: "very keen",
    });
  });

  it("clears a value when it is sent blank", async () => {
    await segmentField();
    const l = await lead();
    await setFieldValues(wsA, "lead", l.id, { segment: "retail" });
    await setFieldValues(wsA, "lead", l.id, { segment: "" });
    expect(await getFieldValues(wsA, "lead", l.id)).toEqual({});
  });

  it("keeps an archived field's value readable but refuses new writes", async () => {
    const def = await segmentField();
    const l = await lead();
    await setFieldValues(wsA, "lead", l.id, { segment: "retail" });
    await updateFieldDef(wsA, { id: def.id, archived: true });

    expect(await getFieldValues(wsA, "lead", l.id)).toEqual({ segment: "retail" });
    const res = await setFieldValues(wsA, "lead", l.id, { segment: "horeca" });
    expect(res.ok).toBe(false);
  });

  it("cannot write a value onto another workspace's lead", async () => {
    await segmentField();
    const otherCompany = await prismaUnsafe.company.create({
      data: { workspaceId: wsB, name: "Bravo Kft" },
    });
    const other = await prismaUnsafe.lead.create({
      data: { workspaceId: wsB, companyId: otherCompany.id, contactName: "Other" },
    });
    const res = await setFieldValues(wsA, "lead", other.id, { segment: "retail" });
    expect(res.ok).toBe(false);
    const after = await prismaUnsafe.lead.findUniqueOrThrow({ where: { id: other.id } });
    expect(after.customFields).toBeNull();
  });

  it("works on deals as well as leads", async () => {
    const created = await createFieldDef(wsA, null, {
      entity: "deal",
      label: "Delivery lead",
      type: "TEXT",
    });
    if (!created.ok) throw new Error(created.error);
    const pipeline = await db().pipeline.create({
      data: {
        workspaceId: wsA,
        key: "p",
        name: "P",
        stages: { create: [{ workspaceId: wsA, key: "s", name: "S", probability: 10 }] },
      },
      include: { stages: true },
    });
    const deal = await db().deal.create({
      data: {
        workspaceId: wsA,
        title: "D",
        pipelineId: pipeline.id,
        stageId: pipeline.stages[0].id,
      },
    });
    const res = await setFieldValues(wsA, "deal", deal.id, { delivery_lead: "Fanni" });
    expect(res.ok).toBe(true);
    expect(await getFieldValues(wsA, "deal", deal.id)).toEqual({ delivery_lead: "Fanni" });
  });
});

describe("the table, the filter and the export", () => {
  it("carries the definitions and the values into the table data", async () => {
    await segmentField();
    const l = await lead();
    await setFieldValues(wsA, "lead", l.id, { segment: "horeca" });

    const table = await loadLeadsTable(wsA, {
      filters: { match: "all", conditions: [] },
      sort: { field: "createdAt", direction: "desc" },
      page: 1,
    });
    expect(table.customFields.map((d) => d.key)).toEqual(["segment"]);
    expect(table.rows[0].customFields).toEqual({ segment: "horeca" });
  });

  it("filters on a custom field, server-side", async () => {
    await segmentField();
    const a = await lead("HoReCa lead");
    const b = await lead("Retail lead");
    await setFieldValues(wsA, "lead", a.id, { segment: "horeca" });
    await setFieldValues(wsA, "lead", b.id, { segment: "retail" });

    const ids = await matchingLeadIds(wsA, {
      match: "all",
      conditions: [{ field: "cf:segment", operator: "is", value: "horeca" }],
    });
    expect(ids).toEqual([a.id]);
  });

  it("exports a custom column with its label and its formatted value", async () => {
    await segmentField();
    const l = await lead();
    await setFieldValues(wsA, "lead", l.id, { segment: "horeca" });

    const csv = await exportLeadsCsv(wsA, [l.id]);
    // The stored value is `horeca`; the export shows what a person reads.
    expect(csvCell(csv, "Segment")).toBe("HoReCa");
  });
});

describe("GDPR", () => {
  it("takes custom values with the lead on erasure", async () => {
    await segmentField();
    const l = await lead();
    await setFieldValues(wsA, "lead", l.id, { segment: "retail" });

    await eraseLeadData(db(), l.id, { eraseDocuments: true });
    expect(await prismaUnsafe.lead.count({ where: { id: l.id } })).toBe(0);
  });

  it("clears custom values when a lead is anonymized", async () => {
    await createFieldDef(wsA, null, { entity: "lead", label: "Note", type: "TEXT" });
    const l = await lead();
    await setFieldValues(wsA, "lead", l.id, { note: "his wife's name is Kata" });

    await anonymizeLead(db(), l.id, Date.now());
    const after = await prismaUnsafe.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.customFields).toBeNull();
    expect(after.contactName).toMatch(/^Anonymized-/);
  });
});
