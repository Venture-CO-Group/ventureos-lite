import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

// Spec §4.13: approval-only mutation. Seed PENDING proposals, then drive the
// Owner approve/reject flow through the real Settings UI (real server action,
// real Next runtime) and assert the DB mutation happens ONLY on approval.
const prisma = new PrismaClient();

let workspaceId = "";
let frameId = "";
let frameProposalId = "";
let weightProposalId = "";

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst();
  if (!ws) throw new Error("no workspace");
  workspaceId = ws.id;

  const frame = await prisma.frame.create({
    data: { workspaceId, name: "E2E Signal Frame", body: "…", version: 1, status: "DRAFT" },
  });
  frameId = frame.id;

  const fp = await prisma.proposal.create({
    data: {
      workspaceId,
      kind: "FRAME_PROMOTION",
      title: "E2E promote signal frame",
      evidence: "reply 22% vs 9% (n=41)",
      n: 41,
      data: { frameName: "E2E Signal Frame", frameId },
    },
  });
  frameProposalId = fp.id;

  const wp = await prisma.proposal.create({
    data: {
      workspaceId,
      kind: "SCORE_WEIGHT",
      title: "E2E weight up trigger_signal",
      evidence: "close 3x with the signal (n=33)",
      n: 33,
      data: { criterion: "trigger_signal", weight: 2 },
    },
  });
  weightProposalId = wp.id;
});

test.afterAll(async () => {
  await prisma.proposal.deleteMany({ where: { id: { in: [frameProposalId, weightProposalId] } } });
  await prisma.frame.deleteMany({ where: { id: frameId } });
  await prisma.$disconnect();
});

test("approving a frame promotion versions the frame; rejecting mutates nothing", async ({ page }) => {
  await page.goto("/settings/admin/sales");

  // Both proposals are pending and visible.
  await expect(page.locator(`[data-proposal="${frameProposalId}"]`)).toBeVisible();
  await expect(page.locator(`[data-proposal="${weightProposalId}"]`)).toBeVisible();

  // Capture the workspace ICP config before any decision.
  const before = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { icpConfig: true } });
  const weightsBefore = JSON.stringify((before?.icpConfig as Record<string, unknown> | null)?.scoreWeights ?? null);

  // Approve the frame promotion.
  await page.locator(`[data-proposal="${frameProposalId}"] [data-testid="approve"]`).click();
  await expect(page.locator(`[data-proposal="${frameProposalId}"]`)).toHaveCount(0);

  // Frame library versioned + approved (the only mutating path).
  const frame = await prisma.frame.findUnique({ where: { id: frameId } });
  expect(frame?.version).toBe(2);
  expect(frame?.status).toBe("APPROVED");
  const fp = await prisma.proposal.findUnique({ where: { id: frameProposalId } });
  expect(fp?.status).toBe("APPROVED");

  // Reject the score-weight change.
  await page.locator(`[data-proposal="${weightProposalId}"] [data-testid="reject"]`).click();
  await expect(page.locator(`[data-proposal="${weightProposalId}"]`)).toHaveCount(0);

  const wp = await prisma.proposal.findUnique({ where: { id: weightProposalId } });
  expect(wp?.status).toBe("REJECTED");

  // Rejection changed NO score weights.
  const after = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { icpConfig: true } });
  const weightsAfter = JSON.stringify((after?.icpConfig as Record<string, unknown> | null)?.scoreWeights ?? null);
  expect(weightsAfter).toBe(weightsBefore);
});
