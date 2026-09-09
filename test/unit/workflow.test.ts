import { describe, it, expect } from "vitest";
import {
  ACTION_DEFS,
  ACTION_TYPES,
  MAX_CHAIN_DEPTH,
  MAX_RULES,
  ROOT_CHAIN,
  canRun,
  conditionsMatch,
  descend,
  describeRule,
  evaluateCondition,
  ruleSchema,
  validateActions,
  conditionFieldsFor,
  isTaskAction,
  isTaskTrigger,
  TASK_ACTIONS,
  TASK_TRIGGERS,
  TRIGGERS,
  TRIGGER_DEFS,
  type Condition,
  type WorkflowFacts,
} from "../../src/modules/workflow/types";

/**
 * Workflow-lite's pure half (playbook-v2 P7/5): the matcher and the cycle
 * protection. The two things worth being certain about are that a condition on
 * a field the trigger did not supply goes QUIET rather than throwing, and that
 * a pair of rules triggering each other cannot run for ever.
 */
const facts: WorkflowFacts = {
  stage: "CONTACTED",
  source: "REFERRAL",
  icpScore: 4,
  industry: "HoReCa",
  city: null,
  signals: ["hiring", "pályázat"],
  "cf:segment": "horeca",
};

const c = (over: Partial<Condition>): Condition => ({
  field: "stage",
  operator: "is",
  value: "CONTACTED",
  ...over,
});

describe("conditions", () => {
  it("compares strings accent- and case-insensitively", () => {
    expect(evaluateCondition(facts, c({ value: "contacted" }))).toBe(true);
    expect(evaluateCondition(facts, c({ field: "industry", value: "horeca" }))).toBe(true);
    expect(evaluateCondition(facts, c({ operator: "is_not", value: "REPLIED" }))).toBe(true);
    expect(evaluateCondition(facts, c({ field: "industry", operator: "contains", value: "reca" }))).toBe(
      true,
    );
  });

  it("compares numbers", () => {
    expect(evaluateCondition(facts, c({ field: "icpScore", operator: "gte", value: 3 }))).toBe(true);
    expect(evaluateCondition(facts, c({ field: "icpScore", operator: "gte", value: 5 }))).toBe(false);
    expect(evaluateCondition(facts, c({ field: "icpScore", operator: "lte", value: 4 }))).toBe(true);
  });

  it("answers is_set / is_not_set, treating blank as absent", () => {
    expect(evaluateCondition(facts, c({ field: "industry", operator: "is_set" }))).toBe(true);
    expect(evaluateCondition(facts, c({ field: "city", operator: "is_not_set" }))).toBe(true);
    expect(evaluateCondition({ ...facts, industry: "  " }, c({ field: "industry", operator: "is_set" }))).toBe(
      false,
    );
  });

  it("matches signals, accents and all", () => {
    expect(evaluateCondition(facts, c({ operator: "has_signal", value: "palyazat" }))).toBe(true);
    expect(evaluateCondition(facts, c({ operator: "not_has_signal", value: "funding" }))).toBe(true);
    expect(evaluateCondition(facts, c({ operator: "has_signal", value: "funding" }))).toBe(false);
  });

  it("reads a custom field by the same cf: reference the filters use", () => {
    expect(evaluateCondition(facts, c({ field: "cf:segment", value: "horeca" }))).toBe(true);
  });

  it("goes quiet on a field the trigger did not supply, rather than throwing", () => {
    // A rule written for one trigger and re-pointed at another must not explode
    // in a background job.
    expect(evaluateCondition(facts, c({ field: "dealValue", operator: "gte", value: 1 }))).toBe(
      false,
    );
    expect(evaluateCondition(facts, c({ field: "nonsense", operator: "is", value: "x" }))).toBe(
      false,
    );
    expect(evaluateCondition(facts, c({ field: "nonsense", operator: "is_not_set" }))).toBe(true);
  });

  it("ANDs the list, and an empty list means 'whenever it fires'", () => {
    expect(conditionsMatch(facts, [])).toBe(true);
    expect(conditionsMatch(facts, [c({}), c({ field: "icpScore", operator: "gte", value: 3 })])).toBe(
      true,
    );
    expect(conditionsMatch(facts, [c({}), c({ field: "icpScore", operator: "gte", value: 9 })])).toBe(
      false,
    );
  });
});

describe("cycle protection", () => {
  const rule = { id: "r1" };
  const other = { id: "r2" };

  it("lets a fresh rule run", () => {
    expect(canRun(rule, ROOT_CHAIN)).toEqual({ allowed: true });
  });

  it("refuses a rule that has already run for this event", () => {
    const chain = descend(rule, ROOT_CHAIN);
    expect(canRun(rule, chain)).toEqual({ allowed: false, reason: "self_trigger" });
    // A DIFFERENT rule is still fine at that depth.
    expect(canRun(other, chain)).toEqual({ allowed: true });
  });

  it("stops a mutually-triggering pair, which the self-check alone would not", () => {
    // r1 → r2 → r1 → r2 … each satisfies "not myself" every time.
    let chain = ROOT_CHAIN;
    const order = [rule, other, rule, other, rule];
    const verdicts = order.map((r) => {
      const verdict = canRun(r, chain);
      if (verdict.allowed) chain = descend(r, chain);
      return verdict.allowed;
    });
    // The depth limit is what ends it.
    expect(verdicts.filter(Boolean).length).toBeLessThanOrEqual(MAX_CHAIN_DEPTH);
    expect(verdicts.at(-1)).toBe(false);
  });

  it("reports the depth limit as the reason, not a self-trigger", () => {
    let chain = ROOT_CHAIN;
    for (const id of ["a", "b", "c"]) chain = descend({ id }, chain);
    expect(canRun({ id: "d" }, chain)).toEqual({ allowed: false, reason: "depth" });
  });
});

describe("the email action drafts and cannot send (CLAUDE.md hard rule #2)", () => {
  it("says so in the copy a person reads while choosing it", () => {
    const note = ACTION_DEFS.draft_email.note.toLowerCase();
    expect(ACTION_DEFS.draft_email.label).toMatch(/DRAFT/);
    expect(note).toContain("never sent");
    expect(note).toContain("sends it");
  });

  it("offers no send action at all", () => {
    const labels = Object.values(ACTION_DEFS).map((a) => a.label.toLowerCase());
    expect(labels.some((l) => /\bsend\b/.test(l))).toBe(false);
  });
});

describe("validation", () => {
  it("names what an action is missing", () => {
    expect(validateActions([{ type: "create_task" }])[0]).toMatch(/title/);
    expect(validateActions([{ type: "draft_email" }])[0]).toMatch(/subject or a template/);
    expect(validateActions([{ type: "add_signal" }])[0]).toMatch(/signal tag/);
    expect(validateActions([{ type: "notify_user" }])[0]).toMatch(/who to notify/);
    expect(validateActions([{ type: "move_not_now" }])).toEqual([]);
  });

  it("requires a name and at least one action", () => {
    expect(
      ruleSchema.safeParse({ name: "", trigger: "lead_created", actions: [] }).success,
    ).toBe(false);
    expect(
      ruleSchema.safeParse({
        name: "Rule",
        trigger: "lead_created",
        actions: [{ type: "move_not_now" }],
      }).success,
    ).toBe(true);
  });

  it("caps the rule set at twenty, which the UI also enforces", () => {
    expect(MAX_RULES).toBe(20);
  });
});

describe("the plain-English summary", () => {
  it("reads as a sentence, which is what a person checks before saving", () => {
    const text = describeRule({
      name: "Kick off",
      trigger: "quote_accepted",
      conditions: [{ field: "icpScore", operator: "gte", value: 4 }],
      actions: [{ type: "create_task", title: "Kick-off call" }],
    });
    expect(text).toBe("When a quote is accepted if icpScore is at least 4 → Create a task");
  });

  it("omits the if-clause when there are no conditions", () => {
    const text = describeRule({
      name: "Any",
      trigger: "lead_created",
      conditions: [],
      actions: [{ type: "move_not_now" }],
    });
    expect(text).not.toContain(" if ");
  });
});

/**
 * Board automations (playbook-v5 P20/5).
 *
 * The engine's writes are in test/integration/workflow.test.ts. These are the
 * rules the vocabulary itself has to enforce — above all that a task action
 * cannot be attached to a trigger that carries no task, because a rule which
 * saves, fires and does nothing for ever is the hardest failure to notice.
 */
describe("task triggers and task actions", () => {
  it("knows which triggers are about a task", () => {
    for (const t of TASK_TRIGGERS) expect(isTaskTrigger(t)).toBe(true);
    expect(isTaskTrigger("lead_stage_changed")).toBe(false);
    expect(isTaskTrigger("nonsense")).toBe(false);
    // The overdue sweep counts: it has always carried a task, and now the
    // board actions can act on it.
    expect(isTaskTrigger("task_overdue")).toBe(true);
  });

  it("knows which actions need one", () => {
    for (const a of TASK_ACTIONS) expect(isTaskAction(a)).toBe(true);
    expect(isTaskAction("draft_email")).toBe(false);
    expect(isTaskAction("notify_team")).toBe(false);
  });

  it("refuses a task action on a lead trigger, and names it", () => {
    const problems = validateActions(
      [{ type: "set_priority", priority: "urgent" }],
      "lead_stage_changed",
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/needs a task trigger/i);
  });

  it("allows the same action on a task trigger", () => {
    expect(
      validateActions([{ type: "set_priority", priority: "urgent" }], "task_created"),
    ).toEqual([]);
  });

  it("still allows a lead action on a lead trigger", () => {
    expect(validateActions([{ type: "move_not_now" }], "lead_stage_changed")).toEqual([]);
  });

  it("says what each new action is missing", () => {
    expect(validateActions([{ type: "set_priority" }], "task_created")[0]).toMatch(/priority/i);
    expect(validateActions([{ type: "set_due_date" }], "task_created")[0]).toMatch(/days/i);
    expect(validateActions([{ type: "add_tag", tag: "  " }], "task_created")[0]).toMatch(/tag/i);
    expect(validateActions([{ type: "move_to_section" }], "task_created")[0]).toMatch(/section/i);
    expect(validateActions([{ type: "create_follow_up" }], "task_created")[0]).toMatch(
      /template/i,
    );
    expect(validateActions([{ type: "notify_team" }], "task_created")[0]).toMatch(/team/i);
  });

  it("treats an empty assignee as a choice, not an omission", () => {
    // "Nobody owns this" is a deliberate outcome, so the empty string passes
    // and only an absent field is refused.
    expect(validateActions([{ type: "assign_task", assigneeId: "" }], "task_created")).toEqual(
      [],
    );
    expect(validateActions([{ type: "assign_task" }], "task_created")[0]).toMatch(/owns it/i);
  });

  it("offers task condition fields on a task trigger and lead fields otherwise", () => {
    const taskKeys = conditionFieldsFor("task_moved").map((f) => f.key);
    expect(taskKeys).toContain("section");
    expect(taskKeys).toContain("priority");
    expect(taskKeys).not.toContain("icpScore");

    const leadKeys = conditionFieldsFor("lead_created").map((f) => f.key);
    expect(leadKeys).toContain("icpScore");
    expect(leadKeys).not.toContain("section");
  });

  it("has a definition for every trigger and every action", () => {
    // A trigger with no definition renders as a raw enum value in the builder.
    for (const t of TRIGGERS) expect(TRIGGER_DEFS[t]?.label, t).toBeTruthy();
    for (const a of ACTION_TYPES) expect(ACTION_DEFS[a]?.label, a).toBeTruthy();
  });
});

describe("tag conditions", () => {
  it("matches on the task's tags, not on the lead's signals", () => {
    const facts = { tags: ["blocked", "design"], signals: ["hiring"] };
    expect(evaluateCondition(facts, { field: "tags", operator: "has_tag", value: "blocked" })).toBe(
      true,
    );
    expect(evaluateCondition(facts, { field: "tags", operator: "has_tag", value: "hiring" })).toBe(
      false,
    );
    expect(
      evaluateCondition(facts, { field: "tags", operator: "not_has_tag", value: "hiring" }),
    ).toBe(true);
  });

  it("folds case and accents, like every other text match here", () => {
    expect(
      evaluateCondition(
        { tags: ["Késésben"] },
        { field: "tags", operator: "has_tag", value: "kesesben" },
      ),
    ).toBe(true);
  });

  it("is false rather than an error when there are no tags at all", () => {
    expect(evaluateCondition({}, { field: "tags", operator: "has_tag", value: "x" })).toBe(false);
    expect(evaluateCondition({}, { field: "tags", operator: "not_has_tag", value: "x" })).toBe(
      true,
    );
  });
});
