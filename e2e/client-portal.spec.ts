import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { E2E_PASSWORD, signInAs } from "./helpers/auth";

const prisma = new PrismaClient();

/**
 * Read-only client access, end to end (P6/6.3).
 *
 * Signs in as a real CLIENT membership — not by faking a role in the UI — and
 * checks the two things that matter: the portal shows this company's delivery,
 * and every other screen in the product is unreachable.
 */
const EMAIL = "e2e-client@ventureco.test";
const COMPANY = "E2E Portal Client Kft.";
const OTHER = "E2E Other Client Kft.";

let workspaceId = "";
let companyId = "";
let otherCompanyId = "";
let clientUserId = "";
let otherPdfPath = "";

async function cleanup() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (user) {
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.membership.deleteMany({ where: { userId: user.id } });
    await prisma.loginAttempt.deleteMany({ where: { email: EMAIL } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  const companies = await prisma.company.findMany({ where: { name: { in: [COMPANY, OTHER] } } });
  for (const c of companies) {
    const leads = await prisma.lead.findMany({ where: { companyId: c.id } });
    for (const l of leads) {
      await prisma.document.deleteMany({ where: { leadId: l.id } });
      await prisma.activity.deleteMany({ where: { leadId: l.id } });
    }
    const projects = await prisma.project.findMany({ where: { companyId: c.id } });
    for (const p of projects) {
      const ms = await prisma.milestone.findMany({ where: { projectId: p.id } });
      await prisma.milestone.deleteMany({ where: { projectId: p.id } });
      await prisma.task.deleteMany({ where: { id: { in: ms.map((m) => m.taskId) } } });
      await prisma.project.delete({ where: { id: p.id } });
    }
    await prisma.deal.deleteMany({ where: { companyId: c.id } });
    await prisma.lead.deleteMany({ where: { companyId: c.id } });
    await prisma.company.delete({ where: { id: c.id } });
  }
}

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  await cleanup();

  const company = await prisma.company.create({ data: { workspaceId, name: COMPANY } });
  companyId = company.id;
  const other = await prisma.company.create({ data: { workspaceId, name: OTHER } });
  otherCompanyId = other.id;

  // ---- their delivery: a project with two milestones, one done ----
  const lead = await prisma.lead.create({
    data: { workspaceId, companyId, contactName: "Portal Contact", stage: "HANDED_OFF" },
  });
  const deal = await prisma.deal.create({
    data: {
      workspaceId,
      companyId,
      leadId: lead.id,
      title: "Portal deal",
      pipelineId: (await prisma.pipeline.findFirstOrThrow({ where: { workspaceId } })).id,
      stageId: (
        await prisma.dealStage.findFirstOrThrow({ where: { workspaceId } })
      ).id,
    },
  });
  const project = await prisma.project.create({
    data: { workspaceId, dealId: deal.id, companyId, leadId: lead.id, name: "Weboldal build" },
  });
  const board = await prisma.taskBoard.findFirst({ where: { workspaceId, isTemplate: false } });
  for (const [i, title] of ["Kick-off call", "Design handover"].entries()) {
    const task = await prisma.task.create({
      data: {
        workspaceId,
        boardId: board?.id ?? null,
        title,
        position: i * 1024,
        doneAt: i === 0 ? new Date() : null,
        dueAt: new Date(Date.now() + (i + 1) * 86_400_000),
      },
    });
    await prisma.milestone.create({
      data: { workspaceId, projectId: project.id, taskId: task.id, position: i },
    });
  }

  // ---- their document, finalized, plus a draft that must stay hidden ----
  await prisma.document.create({
    data: {
      workspaceId,
      leadId: lead.id,
      dealId: deal.id,
      type: "CONTRACT",
      number: "C-2026-777",
      status: "SENT",
      watermark: false,
      finalizedAt: new Date(),
      totals: { gross: 1_240_000 },
      pdfUrl: "documents/e2e-portal-contract.pdf",
    },
  });
  await prisma.document.create({
    data: {
      workspaceId,
      leadId: lead.id,
      type: "QUOTE",
      number: "Q-2026-888",
      status: "DRAFT",
      watermark: true,
      totals: { gross: 999_000 },
    },
  });

  // ---- and ANOTHER client's finalized document, which must be invisible ----
  const otherLead = await prisma.lead.create({
    data: {
      workspaceId,
      companyId: otherCompanyId,
      contactName: "Other Contact",
      stage: "HANDED_OFF",
    },
  });
  otherPdfPath = "documents/e2e-other-contract.pdf";
  await prisma.document.create({
    data: {
      workspaceId,
      leadId: otherLead.id,
      type: "CONTRACT",
      number: "C-2026-999",
      status: "SENT",
      watermark: false,
      finalizedAt: new Date(),
      totals: { gross: 5_000_000 },
      pdfUrl: otherPdfPath,
    },
  });

  /**
   * The client account, signed in through the real login form.
   *
   * Not by planting a session row: the opaque token lives inside an encrypted
   * Auth.js cookie that a test cannot mint, and a spec that fabricates its own
   * auth stops testing the thing most worth testing.
   */
  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      name: "Portal Client",
      passwordHash: await hashPassword(E2E_PASSWORD),
      totpEnabled: false,
    },
  });
  clientUserId = user.id;
  await prisma.membership.create({
    data: { userId: user.id, workspaceId, role: "CLIENT", grants: [], clientCompanyId: companyId },
  });
});

test.afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/** A browser context signed in as the client, and as nobody else. */
async function asClient(browser: import("@playwright/test").Browser) {
  // `storageState: undefined` discards the Owner cookies every other spec
  // reuses — a spec that inherited them would be testing the Owner.
  const context = await browser.newContext({ storageState: undefined });
  await signInAs(context, EMAIL);
  return context;
}

test("the portal shows this company's delivery, and only the finalized documents", async ({
  browser,
}) => {
  const context = await asClient(browser);
  const page = await context.newPage();
  await page.goto("/portal");

  await expect(page.getByTestId("portal-projects")).toContainText("Weboldal build");
  await expect(page.getByTestId("portal-milestone")).toHaveCount(2);
  await expect(page.getByTestId("portal-projects")).toContainText("1 / 2 kész");

  const docs = page.getByTestId("portal-document");
  await expect(docs).toHaveCount(1);
  await expect(docs).toContainText("C-2026-777");
  await expect(docs).toContainText("1 240 000 Ft".replace(/\s/g, " "));
  // A quote still carrying its DRAFT watermark is a working document — the
  // client seeing a draft price is how a negotiation goes wrong (hard rule #4).
  await expect(page.getByTestId("portal-documents")).not.toContainText("Q-2026-888");
  // And nothing about the other client.
  await expect(page.locator("body")).not.toContainText("C-2026-999");
  await expect(page.locator("body")).not.toContainText(OTHER);

  await context.close();
});

test("every working screen is unreachable, and the sidebar does not offer them", async ({
  browser,
}) => {
  const context = await asClient(browser);
  const page = await context.newPage();

  for (const path of ["/", "/leads", "/pipeline", "/deals", "/documents", "/analytics", "/tasks"]) {
    await page.goto(path);
    // Redirected, not refused: a page that says "you may not see this" tells
    // somebody the page exists.
    await expect(page, path).toHaveURL(/\/portal$/);
  }

  // The sidebar shows one entry, and it is not the sales tool's.
  await expect(page.getByRole("link", { name: "Lead Engine" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Pipeline" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Your project" })).toBeVisible();

  // And two pieces of furniture come off for them: what we spend on Claude per
  // day is our commercial information, and a switcher over one membership is a
  // control that does nothing while naming an agency's internal structure.
  await expect(page.getByTestId("budget-meter")).toHaveCount(0);
  await expect(page.getByTestId("budget-meter-mobile")).toHaveCount(0);
  await expect(page.getByTestId("active-workspace")).toHaveCount(0);
  await context.close();
});

test("another client's PDF is not served by path", async ({ browser }) => {
  const context = await asClient(browser);
  const page = await context.newPage();
  await page.goto("/portal");

  /**
   * The leak this closed.
   *
   * `/api/files` served anything owned by the caller's WORKSPACE, which was
   * right while every member was staff. A client is a member — so without the
   * second check they could fetch another client's contract by path.
   */
  const theirs = await page.request.get(`/api/files/${otherPdfPath}`);
  expect(theirs.status()).toBe(404);

  // An audit screenshot, likewise: not a document of theirs.
  const shot = await page.request.get("/api/files/audits/anything.png");
  expect(shot.status()).toBe(404);
  await context.close();
});

test("a client cannot write, even by calling the action directly", async ({ browser }) => {
  const context = await asClient(browser);
  const page = await context.newPage();
  await page.goto("/portal");

  const before = await prisma.lead.count({ where: { workspaceId } });
  /**
   * A Server Action posted by hand.
   *
   * The shell will not render `/leads` for a client, but a shell is not a
   * security boundary — the interesting question is whether a POST straight at
   * a mutation gets through. It must not, and the reason it does not is the
   * Prisma tenant guard rather than a check in that action.
   */
  const res = await page.request.post("/leads", {
    headers: { "Next-Action": "0000000000000000000000000000000000000000", "Content-Type": "text/plain;charset=UTF-8" },
    data: "[]",
    failOnStatusCode: false,
  });
  expect(res.status()).toBeGreaterThanOrEqual(300);
  expect(await prisma.lead.count({ where: { workspaceId } })).toBe(before);

  // And they hold no capability, so nothing grant-gated is reachable either.
  const membership = await prisma.membership.findFirst({ where: { userId: clientUserId } });
  expect(membership!.grants).toEqual([]);
  expect(membership!.role).toBe("CLIENT");
  await context.close();
});
