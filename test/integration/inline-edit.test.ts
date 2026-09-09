import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { applyTaskInlineEdit, TASK_UNEDITABLE_REASON } from "../../src/modules/tasks/inline";
import { applyDealInlineEdit } from "../../src/modules/deals/inline";
import { applyDetailInlineEdit } from "../../src/modules/leads/detail-inline";

/**
 * The server side of inline editing (playbook-v5 P16/1).
 *
 * ── WHY THIS IS THE IMPORTANT HALF ─────────────────────────────────────────
 *
 * The optimistic update is a display convenience and NEVER an authorization
 * shortcut. Everything that decides whether an edit is allowed lives here, and
 * a cell only ever renders what comes back — so these are the tests that say
 * the feature is safe, and the browser test only says it is wired up.
 */
const WS = "Inline Edit WS";
const OTHER_WS = "Inline Edit Other WS";
let workspaceId = "";
let otherWorkspaceId = "";
let memberId = "";
let suspendedId = "";
let strangerId = "";

async function user(email: string) {
  const existing = await prismaUnsafe.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prismaUnsafe.user.create({
    data: { email, name: email.split("@")[0]!, passwordHash: "x" },
  });
}

beforeAll(async () => {
  const ws =
    (await prismaUnsafe.workspace.findFirst({ where: { name: WS } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: WS } }));
  workspaceId = ws.id;
  const other =
    (await prismaUnsafe.workspace.findFirst({ where: { name: OTHER_WS } })) ??
    (await prismaUnsafe.workspace.create({ data: { name: OTHER_WS } }));
  otherWorkspaceId = other.id;

  const m = await user("inline-member@ventureco.test");
  const s = await user("inline-suspended@ventureco.test");
  const x = await user("inline-stranger@ventureco.test");
  memberId = m.id;
  suspendedId = s.id;
  strangerId = x.id;

  for (const [userId, state] of [
    [memberId, "ACTIVE"],
    [suspendedId, "SUSPENDED"],
  ] as const) {
    await prismaUnsafe.membership.upsert({
      where: { userId_workspaceId: { userId, workspaceId } },
      update: { state, role: "BDR", grants: [] },
      create: { userId, workspaceId, state, role: "BDR", grants: [] },
    });
  }
  // The stranger belongs to the OTHER workspace, which is the point of them.
  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId: strangerId, workspaceId: otherWorkspaceId } },
    update: { state: "ACTIVE", role: "BDR", grants: [] },
    create: { userId: strangerId, workspaceId: otherWorkspaceId, state: "ACTIVE", role: "BDR", grants: [] },
  });
});

afterAll(async () => {
  for (const id of [workspaceId, otherWorkspaceId]) {
    await prismaUnsafe.task.deleteMany({ where: { workspaceId: id } });
    await prismaUnsafe.activity.deleteMany({ where: { workspaceId: id } });
    await prismaUnsafe.lead.deleteMany({ where: { workspaceId: id } });
    await prismaUnsafe.company.deleteMany({ where: { workspaceId: id } });
  }
});

async function task(over: Record<string, unknown> = {}) {
  return prismaUnsafe.task.create({
    data: { workspaceId, title: "Inline subject", ...over },
  });
}

describe("a task, edited in place", () => {
  it("trims a title and hands back what it stored", async () => {
    const t = await task();
    const res = await applyTaskInlineEdit(workspaceId, memberId, {
      taskId: t.id,
      field: "title",
      value: "   Renamed   ",
    });
    expect(res).toEqual({ ok: true, value: "Renamed" });
    expect((await prismaUnsafe.task.findUnique({ where: { id: t.id } }))!.title).toBe("Renamed");
  });

  it("refuses an empty title rather than storing a nameless task", async () => {
    const t = await task();
    const res = await applyTaskInlineEdit(workspaceId, memberId, {
      taskId: t.id,
      field: "title",
      value: "   ",
    });
    expect(res.ok).toBe(false);
    expect((await prismaUnsafe.task.findUnique({ where: { id: t.id } }))!.title).toBe(
      "Inline subject",
    );
  });

  describe("the two dates", () => {
    it("refuses a start after its due date", async () => {
      const t = await task({
        startAt: new Date("2026-10-10T12:00:00Z"),
        dueAt: new Date("2026-10-15T12:00:00Z"),
      });
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field: "startAt",
        value: "2026-10-20",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/cannot start after it is due/i);
    });

    /** The same error from the other side, which is how a chip edit hits it. */
    it("refuses a due date before its start", async () => {
      const t = await task({
        startAt: new Date("2026-10-10T12:00:00Z"),
        dueAt: new Date("2026-10-15T12:00:00Z"),
      });
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field: "dueAt",
        value: "2026-10-05",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/due before it starts/i);
      expect(
        (await prismaUnsafe.task.findUnique({ where: { id: t.id } }))!.dueAt!.toISOString(),
      ).toBe("2026-10-15T12:00:00.000Z");
    });

    /** A task with only one of the pair has nothing to contradict. */
    it("allows any due date when there is no start date", async () => {
      const t = await task({ dueAt: new Date("2026-10-15T12:00:00Z") });
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field: "dueAt",
        value: "2020-01-01",
      });
      expect(res.ok).toBe(true);
    });

    it("clears a date on an empty value", async () => {
      const t = await task({ dueAt: new Date("2026-10-15T12:00:00Z") });
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field: "dueAt",
        value: "",
      });
      expect(res).toEqual({ ok: true, value: null });
      expect((await prismaUnsafe.task.findUnique({ where: { id: t.id } }))!.dueAt).toBeNull();
    });

    it("refuses something that is not a date", async () => {
      const t = await task();
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field: "dueAt",
        value: "next tuesday",
      });
      expect(res.ok).toBe(false);
    });
  });

  describe("the assignee", () => {
    it("accepts a member of this workspace", async () => {
      const t = await task();
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field: "assigneeId",
        value: memberId,
      });
      expect(res).toEqual({ ok: true, value: memberId });
    });

    /** Otherwise an id typed into a form assigns work to a stranger. */
    it("refuses somebody who is not in this workspace", async () => {
      const t = await task();
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field: "assigneeId",
        value: strangerId,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/not in this workspace/i);
      expect((await prismaUnsafe.task.findUnique({ where: { id: t.id } }))!.assigneeId).toBeNull();
    });

    /** Suspended access means they cannot act on it, so it must not land there. */
    it("refuses somebody whose access is suspended", async () => {
      const t = await task();
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field: "assigneeId",
        value: suspendedId,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/suspended/i);
    });

    it("unassigns on an empty value, which is visible rather than hidden", async () => {
      const t = await task({ assigneeId: memberId });
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field: "assigneeId",
        value: "",
      });
      expect(res).toEqual({ ok: true, value: null });
    });
  });

  describe("tags", () => {
    it("de-duplicates and drops the blanks", async () => {
      const t = await task();
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field: "tags",
        value: ["seo", " seo ", "", "audit"],
      });
      expect(res).toEqual({ ok: true, value: ["seo", "audit"] });
    });

    it("refuses more than twelve", async () => {
      const t = await task();
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field: "tags",
        value: Array.from({ length: 13 }, (_, i) => `t${i}`),
      });
      expect(res.ok).toBe(false);
    });
  });

  describe("what a cell may not write", () => {
    /**
     * Each of these has a real reason, and the refusal names it — a cell that
     * silently does nothing reads as broken.
     */
    it.each(Object.keys(TASK_UNEDITABLE_REASON))("refuses %s, with the reason", async (field) => {
      const t = await task();
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field,
        value: "anything",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe(TASK_UNEDITABLE_REASON[field]);
    });

    it("refuses a field nobody has heard of", async () => {
      const t = await task();
      const res = await applyTaskInlineEdit(workspaceId, memberId, {
        taskId: t.id,
        field: "workspaceId",
        value: otherWorkspaceId,
      });
      expect(res.ok).toBe(false);
    });
  });

  /**
   * A dependency is REPORTED, never enforced — the model's own comment says so.
   * Refusing to edit a blocked task would mean the product deciding its graph
   * is more accurate than the person looking at the work.
   */
  it("still edits a task that is blocked by another", async () => {
    const blocker = await task({ title: "Blocker" });
    const blocked = await task({ title: "Blocked" });
    await prismaUnsafe.taskDependency.create({
      data: { workspaceId, taskId: blocked.id, blockedById: blocker.id },
    });
    const res = await applyTaskInlineEdit(workspaceId, memberId, {
      taskId: blocked.id,
      field: "priority",
      value: "urgent",
    });
    expect(res.ok).toBe(true);
  });

  /** The tenant guard, from the other direction. */
  it("cannot reach a task in another workspace", async () => {
    const mine = await prismaUnsafe.task.create({
      data: { workspaceId: otherWorkspaceId, title: "Theirs" },
    });
    const res = await applyTaskInlineEdit(workspaceId, memberId, {
      taskId: mine.id,
      field: "title",
      value: "Mine now",
    });
    expect(res.ok).toBe(false);
    expect((await prismaUnsafe.task.findUnique({ where: { id: mine.id } }))!.title).toBe("Theirs");
  });
});

describe("a lead's company block, edited in place", () => {
  async function lead(companyId?: string) {
    return prismaUnsafe.lead.create({
      data: { workspaceId, contactName: "Inline Person", companyId: companyId ?? null },
    });
  }

  /**
   * The rule the Save button carried and per-field commits must not lose: the
   * adószám is unique per workspace, so a clash is REFUSED rather than
   * silently merging two companies.
   */
  it("refuses an adószám another company already has, and names it", async () => {
    const taken = await prismaUnsafe.company.create({
      data: { workspaceId, name: "Already Has It Kft", taxId: "11111111-2-33" },
    });
    const mine = await prismaUnsafe.company.create({
      data: { workspaceId, name: "Mine Kft" },
    });
    const l = await lead(mine.id);
    const res = await applyDetailInlineEdit(workspaceId, memberId, {
      leadId: l.id,
      field: "company.taxId",
      value: "11111111-2-33",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Already Has It Kft");
    expect((await prismaUnsafe.company.findUnique({ where: { id: mine.id } }))!.taxId).toBeNull();
    void taken;
  });

  it("keeps its own adószám on a re-save", async () => {
    const c = await prismaUnsafe.company.create({
      data: { workspaceId, name: "Same Kft", taxId: "22222222-2-33" },
    });
    const l = await lead(c.id);
    const res = await applyDetailInlineEdit(workspaceId, memberId, {
      leadId: l.id,
      field: "company.taxId",
      value: "22222222-2-33",
    });
    expect(res.ok).toBe(true);
  });

  /**
   * The second rule: a lead may have NO company row — captured from LinkedIn,
   * or typed by hand — and the panel shows the fields regardless. Filling the
   * name has to create the company and link it, not discard what was typed.
   */
  it("creates and links a company when the lead had none", async () => {
    const l = await lead();
    const res = await applyDetailInlineEdit(workspaceId, memberId, {
      leadId: l.id,
      field: "company.name",
      value: "Brand New Kft",
    });
    expect(res.ok).toBe(true);
    const after = await prismaUnsafe.lead.findUnique({
      where: { id: l.id },
      include: { company: true },
    });
    expect(after!.company!.name).toBe("Brand New Kft");
  });

  /** A city on its own would make a nameless company nobody can find again. */
  it("asks for a name first when there is no company yet", async () => {
    const l = await lead();
    const res = await applyDetailInlineEdit(workspaceId, memberId, {
      leadId: l.id,
      field: "company.city",
      value: "Debrecen",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/name first/i);
  });

  it("refuses a domain that is a URL rather than a domain", async () => {
    const c = await prismaUnsafe.company.create({ data: { workspaceId, name: "Domain Kft" } });
    const l = await lead(c.id);
    for (const bad of ["https://example.hu", "example.hu/pricing", "not a domain"]) {
      const res = await applyDetailInlineEdit(workspaceId, memberId, {
        leadId: l.id,
        field: "company.domain",
        value: bad,
      });
      expect(res.ok, bad).toBe(false);
    }
  });

  /**
   * The third rule: a human choosing a language PINS it, or the next capture
   * re-detects from profile text and silently undoes the correction.
   */
  it("pins the language when a person sets it", async () => {
    const l = await lead();
    const res = await applyDetailInlineEdit(workspaceId, memberId, {
      leadId: l.id,
      field: "language",
      value: "EN",
    });
    expect(res.ok).toBe(true);
    const after = await prismaUnsafe.lead.findUnique({ where: { id: l.id } });
    expect(after!.language).toBe("EN");
    expect(after!.languageConfidence).toBe("manual");
  });

  it("refuses an email that is not one, and leaves the old value", async () => {
    const l = await prismaUnsafe.lead.create({
      data: { workspaceId, contactName: "Mailer", email: "good@example.com" },
    });
    const res = await applyDetailInlineEdit(workspaceId, memberId, {
      leadId: l.id,
      field: "email",
      value: "not-an-email",
    });
    expect(res.ok).toBe(false);
    expect((await prismaUnsafe.lead.findUnique({ where: { id: l.id } }))!.email).toBe(
      "good@example.com",
    );
  });

  /**
   * The company is a SHARED record, which is why the table refuses to edit it
   * from a lead row — but the detail panel's company block is explicitly about
   * the company, so the same edit is right there. Same primitive, different
   * permission, because the surface means something different.
   */
  it("is where company edits are allowed, unlike the table", async () => {
    const { applyInlineEdit } = await import("../../src/modules/leads/inline");
    const c = await prismaUnsafe.company.create({ data: { workspaceId, name: "Shared Kft" } });
    const l = await lead(c.id);

    const fromTable = await applyInlineEdit(workspaceId, memberId, {
      leadId: l.id,
      field: "company.name",
      value: "Renamed From A Row",
    });
    expect(fromTable.ok).toBe(false);

    const fromPanel = await applyDetailInlineEdit(workspaceId, memberId, {
      leadId: l.id,
      field: "company.name",
      value: "Renamed From The Panel",
    });
    expect(fromPanel.ok).toBe(true);
  });
});

describe("a deal, edited in place", () => {
  async function deal(over: Record<string, unknown> = {}) {
    const pipeline = await prismaUnsafe.pipeline.findFirst({ where: { workspaceId } });
    const p =
      pipeline ??
      (await prismaUnsafe.pipeline.create({
        data: { workspaceId, name: "Inline Pipeline", key: "inline", isDefault: true },
      }));
    let stage = await prismaUnsafe.dealStage.findFirst({ where: { pipelineId: p.id } });
    stage ??= await prismaUnsafe.dealStage.create({
      data: {
        workspaceId,
        pipelineId: p.id,
        name: "Open",
        key: "open",
        position: 1024,
        probability: 40,
      },
    });
    return prismaUnsafe.deal.create({
      data: {
        workspaceId,
        title: "Inline deal",
        pipelineId: p.id,
        stageId: stage.id,
        value: 500_000,
        ...over,
      },
    });
  }

  afterAll(async () => {
    await prismaUnsafe.deal.deleteMany({ where: { workspaceId } });
    await prismaUnsafe.dealStage.deleteMany({ where: { workspaceId } });
    await prismaUnsafe.pipeline.deleteMany({ where: { workspaceId } });
  });

  /**
   * Money is an integer of forints (CLAUDE.md). The board used to round on the
   * CLIENT — `Math.round(Number(next) || 0)` turned "abc" into 0 and "1.5"
   * into 2 without telling anybody.
   */
  it("refuses a fractional amount rather than rounding it", async () => {
    const d = await deal();
    const res = await applyDealInlineEdit(workspaceId, memberId, {
      dealId: d.id,
      field: "value",
      value: 1.5,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/whole forints/i);
  });

  it("refuses something that is not a number rather than storing zero", async () => {
    const d = await deal();
    const res = await applyDealInlineEdit(workspaceId, memberId, {
      dealId: d.id,
      field: "value",
      value: "abc",
    });
    expect(res.ok).toBe(false);
    expect((await prismaUnsafe.deal.findUnique({ where: { id: d.id } }))!.value).toBe(500_000);
  });

  it("refuses an amount that is three zeroes past plausible", async () => {
    const d = await deal();
    const res = await applyDealInlineEdit(workspaceId, memberId, {
      dealId: d.id,
      field: "value",
      value: 900_000_000_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/typo/i);
  });

  it("accepts a whole amount with spaces in it, as typed", async () => {
    const d = await deal();
    const res = await applyDealInlineEdit(workspaceId, memberId, {
      dealId: d.id,
      field: "value",
      value: "1 250 000",
    });
    expect(res).toEqual({ ok: true, value: 1_250_000 });
  });

  /** Null hands the weight back to the stage; zero is a different statement. */
  it("clears a probability override rather than setting it to zero", async () => {
    const d = await deal({ probability: 90 });
    const res = await applyDealInlineEdit(workspaceId, memberId, {
      dealId: d.id,
      field: "probability",
      value: null,
    });
    expect(res).toEqual({ ok: true, value: null });
    expect((await prismaUnsafe.deal.findUnique({ where: { id: d.id } }))!.probability).toBeNull();
  });

  /**
   * A closed deal is a record of what happened, and the revenue figures are
   * already built on it.
   */
  it("refuses to change the numbers on a closed deal", async () => {
    const d = await deal({ status: "WON", closedAt: new Date() });
    const res = await applyDealInlineEdit(workspaceId, memberId, {
      dealId: d.id,
      field: "value",
      value: 999,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/closed/i);
  });

  it("refuses the fields that belong to moving or closing a deal", async () => {
    const d = await deal();
    for (const field of ["stageId", "status", "closedAt", "lostReason", "currency"]) {
      const res = await applyDealInlineEdit(workspaceId, memberId, {
        dealId: d.id,
        field,
        value: "x",
      });
      expect(res.ok, field).toBe(false);
    }
  });
});
