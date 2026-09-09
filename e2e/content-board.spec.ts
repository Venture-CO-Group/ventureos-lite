import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { signInAs, E2E_PASSWORD } from "./helpers/auth";

/**
 * P1/2 — the Content Hub board.
 *
 * The two things worth proving are the ones a screenshot cannot: that a card
 * really moves across phases, and that a BDR dragging into Approved is
 * refused by the SERVER and snaps back, rather than being hidden by the UI.
 */
const prisma = new PrismaClient();
const BDR_EMAIL = "content-bdr@ventureco.test";

/**
 * Serial: the config runs tests fully parallel, and these all drag cards on the
 * one shared board. Concurrent runs pile up cards in the same columns and move
 * the drop targets under each other, which fails as flake rather than as a
 * real defect.
 */
test.describe.configure({ mode: "serial" });

const EXCERPT =
  "Egy elég hosszú tervezet, ami több sorban is elfér, hogy a kártyán a levágás látszódjon. ".repeat(
    3,
  );

/**
 * A topic with one channel's text. The card is the TOPIC now — the text lives in
 * a variant, one per channel — so a seed has to create both.
 */
async function seedPost(title: string, status: "DRAFT" | "IN_REVIEW" = "DRAFT") {
  // Oldest first: an unordered findFirst seeds the post into whatever
  // workspace the database happens to return, and a suite that creates
  // workspaces (or a test run that left one behind) then puts the card on a
  // board the signed-in user is not looking at.
  const ws = await prisma.workspace.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const post = await prisma.contentPost.create({
    data: { workspaceId: ws!.id, title, status },
  });
  await prisma.contentVariant.create({
    data: { workspaceId: ws!.id, postId: post.id, channel: "linkedin", body: EXCERPT },
  });
  return ws!.id;
}

async function dragCardTo(page: Page, title: string, targetStatus: string) {
  const card = page.locator('[data-testid="content-card"]', { hasText: title });
  await card.dragTo(page.getByTestId(`content-col-${targetStatus}`));
  // The board refuses a second drop while one is in flight, so wait for it to
  // settle rather than racing it — a person cannot drag twice in 50ms either.
  await expect(page.getByTestId("content-board")).toHaveAttribute("data-pending", "false");
}

test.afterAll(async () => {
  await prisma.contentPost.deleteMany({ where: { title: { startsWith: "E2E board " } } });
  await prisma.$disconnect();
});

test("a card carries its title, status and a clamped excerpt", async ({ page }) => {
  const title = `E2E board card ${Date.now()}`;
  await seedPost(title);
  await page.goto("/content");

  const card = page.locator('[data-testid="content-card"]', { hasText: title });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Draft");

  // The excerpt is clamped to a couple of lines rather than printing the body.
  const clamped = card.locator(".line-clamp-2");
  await expect(clamped).toBeVisible();
  const box = await clamped.boundingBox();
  expect(box!.height).toBeLessThan(50);
});

test("dragging moves a post forward through the phases", async ({ page }) => {
  const title = `E2E board move ${Date.now()}`;
  await seedPost(title);
  await page.goto("/content");

  await dragCardTo(page, title, "IN_REVIEW");
  await expect(
    page.getByTestId("content-col-IN_REVIEW").locator('[data-testid="content-card"]', { hasText: title }),
  ).toBeVisible();

  // Owner may approve, so the next phase is allowed too.
  await dragCardTo(page, title, "APPROVED");
  await expect(
    page.getByTestId("content-col-APPROVED").locator('[data-testid="content-card"]', { hasText: title }),
  ).toBeVisible();

  // Survives a reload — it was persisted, not just moved in the DOM.
  await page.reload();
  await expect(
    page.getByTestId("content-col-APPROVED").locator('[data-testid="content-card"]', { hasText: title }),
  ).toBeVisible();
});

test("an illegal jump is refused and the card snaps back", async ({ page }) => {
  const title = `E2E board jump ${Date.now()}`;
  await seedPost(title);
  await page.goto("/content");

  // Draft → Published skips review entirely.
  await dragCardTo(page, title, "PUBLISHED");

  await expect(page.getByText(/cannot go straight from Draft to Published/i)).toBeVisible();
  await expect(
    page.getByTestId("content-col-DRAFT").locator('[data-testid="content-card"]', { hasText: title }),
  ).toBeVisible();
});

/**
 * Approval widened with the BDR role.
 *
 * Content is the workspace's own marketing, not a legal document, and the two
 * things a BDR still may not do are manage users and handle documents. This
 * used to assert the refusal; the refusal itself is still pinned, one layer
 * down, by `canTransition(..., isApprover: false)` in the unit tests — which is
 * where a rule with no seat belongs, since somebody with no membership cannot
 * reach this board at all.
 */
test("a BDR may approve a post", async ({ browser }) => {
  const title = `E2E board grant ${Date.now()}`;
  const workspaceId = await seedPost(title, "IN_REVIEW");

  const user = await prisma.user.upsert({
    where: { email: BDR_EMAIL },
    update: { passwordHash: await hashPassword(E2E_PASSWORD) },
    create: {
      email: BDR_EMAIL,
      name: "Content BDR",
      passwordHash: await hashPassword(E2E_PASSWORD),
    },
  });
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
    update: { role: "BDR", grants: [] },
    create: { userId: user.id, workspaceId, role: "BDR", grants: [] },
  });

  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    await signInAs(context, BDR_EMAIL);
    const page = await context.newPage();
    await page.goto("/content");

    await dragCardTo(page, title, "APPROVED");

    // It stays where it was dropped, and a reload agrees — the server took it.
    await expect(
      page.getByTestId("content-col-APPROVED").locator('[data-testid="content-card"]', { hasText: title }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByTestId("content-col-APPROVED").locator('[data-testid="content-card"]', { hasText: title }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
