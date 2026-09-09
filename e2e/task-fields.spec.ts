import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RUN = String(Date.now());
const BOARD = `E2E Fields Board ${RUN}`;
const KEY = `segment_${RUN}`.slice(0, 40);
let workspaceId = "";
let boardId = "";
let sectionId = "";
let taskId = "";
let defId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;

  const board = await prisma.taskBoard.create({
    data: {
      workspaceId,
      name: BOARD,
      sections: { create: [{ workspaceId, name: "Doing", position: 1024 }] },
    },
    include: { sections: true },
  });
  boardId = board.id;
  sectionId = board.sections[0]!.id;
  taskId = (
    await prisma.task.create({
      data: { workspaceId, boardId, sectionId, title: `Field task ${RUN}`, position: 1024 },
    })
  ).id;

  /**
   * A TASK-scoped definition, in the same table that serves leads, companies
   * and deals — which is the whole point of the item.
   */
  defId = (
    await prisma.customFieldDef.create({
      data: {
        workspaceId,
        entity: "task",
        key: KEY,
        label: "Segment",
        type: "SELECT",
        options: [
          { value: "smb", label: "SMB" },
          { value: "enterprise", label: "Enterprise" },
        ],
        position: 0,
      },
    })
  ).id;
});

test.afterAll(async () => {
  await prisma.customFieldDef.deleteMany({ where: { id: defId } });
  await prisma.task.deleteMany({ where: { boardId } });
  await prisma.taskSection.deleteMany({ where: { boardId } });
  await prisma.taskBoard.deleteMany({ where: { id: boardId } });
  await prisma.$disconnect();
});

/**
 * Custom fields on tasks (playbook-v5 P20/2).
 *
 * ── NOTHING NEW WAS BUILT, WHICH IS THE POINT ───────────────────────────────
 *
 * The definition lives in the same `custom_field_defs` table as every other
 * entity's, validated by the same code. So the test worth having is that a
 * TASK-scoped definition reaches a task, and that grouping by it works.
 */
test("a task-scoped field appears on the task and saves through the shared validator", async ({
  page,
}) => {
  await page.goto(`/tasks?board=${boardId}&task=${taskId}`);
  const field = page.getByTestId(`task-field-${KEY}`);
  await expect(field).toBeVisible({ timeout: 20_000 });

  await field.getByTestId("inline-cell").click();
  await field.getByRole("combobox").selectOption("enterprise");

  await expect
    .poll(
      async () => {
        const t = await prisma.task.findUnique({ where: { id: taskId } });
        return (t!.customFields as Record<string, unknown> | null)?.[KEY];
      },
      { timeout: 20_000 },
    )
    .toBe("enterprise");
});

/**
 * And it can group the board — with columns coming from the DEFINITION, so an
 * unused option is still somewhere to drop.
 */
test("the board can be grouped by it, and a drop sets it", async ({ page }) => {
  await page.goto(`/tasks?board=${boardId}`);
  await expect(page.getByTestId("task-card").first()).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("group-by-custom").click();
  await page.getByTestId("group-by-custom-field").selectOption(KEY);
  await expect(page.getByTestId("grouped-board")).toBeVisible({ timeout: 20_000 });

  // Both options are columns, even one nothing is in.
  await expect(page.locator('[data-group-key="smb"]')).toHaveCount(1);
  await expect(page.locator('[data-group-key="enterprise"]')).toHaveCount(1);
  await expect(page.locator('[data-group-key="__unset__"]')).toHaveCount(1);
  await expect(page.getByTestId("grouping-note")).toContainText("Segment");

  await page.evaluate(
    ({ taskId }) => {
      const source = document.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
      const target = document.querySelector<HTMLElement>('[data-group-key="smb"]');
      if (!source || !target) throw new Error("drag endpoints not found");
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
    },
    { taskId },
  );

  await expect
    .poll(
      async () => {
        const t = await prisma.task.findUnique({ where: { id: taskId } });
        return (t!.customFields as Record<string, unknown> | null)?.[KEY];
      },
      { timeout: 20_000 },
    )
    .toBe("smb");

  // THE RULE STILL HOLDS: a regroup does not move the card between columns.
  const after = await prisma.task.findUnique({ where: { id: taskId } });
  expect(after!.sectionId).toBe(sectionId);
});

/**
 * An ARCHIVED definition keeps its stored values but stops being offered —
 * which is the existing behaviour and the reason archiving exists rather than
 * deleting.
 */
test("archiving the definition hides the field but keeps the value", async ({ page }) => {
  await prisma.task.update({
    where: { id: taskId },
    data: { customFields: { [KEY]: "smb" } },
  });
  await prisma.customFieldDef.update({ where: { id: defId }, data: { archived: true } });
  try {
    await page.goto(`/tasks?board=${boardId}&task=${taskId}`);
    await expect(page.getByTestId("detail-title")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`task-field-${KEY}`)).toHaveCount(0);

    // The value is still there — archiving is not erasure.
    const t = await prisma.task.findUnique({ where: { id: taskId } });
    expect((t!.customFields as Record<string, unknown>)[KEY]).toBe("smb");
  } finally {
    await prisma.customFieldDef.update({ where: { id: defId }, data: { archived: false } });
  }
});
