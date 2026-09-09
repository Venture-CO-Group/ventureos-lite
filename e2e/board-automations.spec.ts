import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
const RULE = `E2E board rule ${RUN}`;
let workspaceId = "";
let boardId = "";
let doingId = "";
let blockedId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  const board = await prisma.taskBoard.create({
    data: {
      workspaceId,
      name: `E2E Automation Board ${RUN}`,
      sections: {
        create: [
          { workspaceId, name: "Doing", position: 1024 },
          { workspaceId, name: "Blocked", position: 2048 },
        ],
      },
    },
    include: { sections: { orderBy: { position: "asc" } } },
  });
  boardId = board.id;
  doingId = board.sections[0]!.id;
  blockedId = board.sections[1]!.id;
});

test.afterAll(async () => {
  // The rule must not survive this spec: a rule left enabled fires on every
  // later spec's board and makes them fail somewhere else entirely.
  const rule = await prisma.workflowRule.findFirst({ where: { workspaceId, name: RULE } });
  if (rule) {
    await prisma.workflowRun.deleteMany({ where: { ruleId: rule.id } });
    await prisma.workflowRule.delete({ where: { id: rule.id } });
  }
  await prisma.task.deleteMany({ where: { boardId } });
  await prisma.taskSection.deleteMany({ where: { boardId } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.$disconnect();
});

/**
 * Board automations through the UI (playbook-v5 P20/5).
 *
 * Written as one journey on purpose: the rule is built in Settings by the same
 * builder the lead rules use, fired by an ordinary drag on the board, and read
 * back in the same run log. If any of the three were a separate system this
 * test could not be written this way.
 */
test("a rule built in settings fires on a board drag and lands in the log", async ({ page }) => {
  await page.goto("/settings/admin/workspace");
  const panel = page.getByTestId("settings-workflows");
  await expect(panel).toBeVisible({ timeout: 20_000 });

  await panel.getByTestId("rule-new").click();
  const editor = page.getByTestId("rule-editor");
  await editor.getByTestId("rule-name").fill(RULE);
  await editor.getByTestId("rule-trigger").selectOption("task_moved");

  // The board picker only exists for a task trigger.
  await editor.getByTestId("rule-board").selectOption(boardId);
  await editor.getByTestId("rule-section").selectOption(blockedId);

  await editor.getByTestId("action-type").selectOption("set_priority");
  await editor.getByTestId("action-priority").selectOption("urgent");
  await editor.getByTestId("rule-save").click();

  await expect(page.getByTestId("rule-list")).toContainText(RULE);
  // The list says which board it watches — one board and every board are very
  // different rules.
  const listed = page.getByTestId("rule-list").locator("li").filter({ hasText: RULE });
  await expect(listed.getByTestId("rule-scope")).toContainText("E2E Automation Board");

  // Now do the thing that fires it: drag a card into Blocked.
  const taskId = (
    await prisma.task.create({
      data: {
        workspaceId,
        boardId,
        sectionId: doingId,
        title: `Automated task ${RUN}`,
        position: 1024,
      },
    })
  ).id;

  await page.goto(`/tasks?board=${boardId}`);
  await expect(page.locator(`[data-task-id="${taskId}"]`)).toBeVisible({ timeout: 20_000 });

  await page.evaluate(
    ({ taskId, blockedId }) => {
      const source = document.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
      const target = document.querySelector<HTMLElement>(`[data-section-id="${blockedId}"]`);
      if (!source || !target) throw new Error("drag endpoints not found");
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
    },
    { taskId, blockedId },
  );

  await expect
    .poll(async () => (await prisma.task.findUnique({ where: { id: taskId } }))!.priority, {
      timeout: 20_000,
    })
    .toBe("urgent");

  // And the log says what fired on what, with the result.
  await page.goto("/settings/admin/workspace");
  const rule = page.getByTestId("rule-list").locator("li").filter({ hasText: RULE });
  await rule.getByTestId("rule-log-toggle").click();
  await expect(rule.getByTestId("rule-log")).toContainText("Set priority to urgent");
});

test("at the rule limit it says so and refuses, rather than dropping one", async ({ page }) => {
  const filler = Array.from({ length: 20 }, (_, i) => `E2E cap ${RUN} ${i}`);
  const existing = await prisma.workflowRule.count({ where: { workspaceId } });
  const needed = Math.max(0, 20 - existing);
  await prisma.workflowRule.createMany({
    data: filler.slice(0, needed).map((name) => ({
      workspaceId,
      name,
      trigger: "task_created",
      triggerConfig: {},
      conditions: [],
      actions: [{ type: "add_tag", tag: "capped" }],
      // Off, so filling the cap cannot change what any other spec sees happen.
      enabled: false,
    })),
  });

  try {
    await page.goto("/settings/admin/workspace");
    const panel = page.getByTestId("settings-workflows");
    await expect(panel).toBeVisible({ timeout: 20_000 });

    /**
     * Loudly: the control says what the matter is instead of opening an editor
     * whose save would fail, and — the part that matters — nothing was dropped
     * to make room. The server refuses the same thing again if anybody reaches
     * past the UI.
     */
    const add = panel.getByTestId("rule-new");
    await expect(add).toBeDisabled();
    await expect(add).toContainText(/20-rule limit/i);
    expect(await prisma.workflowRule.count({ where: { workspaceId } })).toBe(20);
  } finally {
    await prisma.workflowRule.deleteMany({ where: { workspaceId, name: { in: filler } } });
  }
});
