import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * One card per topic, holding a text per channel.
 *
 * "Content hubban lehessen egy témában egy kártyán belül linkeden/blog/newsletter
 * is, ne kelljen fajtánként új kártya ugyanarra a témára."
 *
 * The thing worth proving here is the thing a screenshot cannot: that adding a
 * channel keeps ONE card and does not spawn a second, and that the text written
 * under each tab is stored against that channel rather than overwriting the
 * other one.
 */
const prisma = new PrismaClient();
const PREFIX = "E2E variants ";

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await prisma.contentPost.deleteMany({ where: { title: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

async function seed(title: string) {
  const ws = await prisma.workspace.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const post = await prisma.contentPost.create({
    data: { workspaceId: ws!.id, title, status: "DRAFT" },
  });
  await prisma.contentVariant.create({
    data: {
      workspaceId: ws!.id,
      postId: post.id,
      channel: "linkedin",
      body: "A LinkedIn változat szövege.",
    },
  });
  return post.id;
}

test("a topic gains a blog and a newsletter version inside the same card", async ({ page }) => {
  const title = `${PREFIX}${Date.now()}`;
  const postId = await seed(title);
  await page.goto("/content");

  const card = page.locator('[data-testid="content-card"]', { hasText: title });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("content-card-channel-linkedin")).toBeVisible();
  await card.click();

  // Two more channels, from inside the one card.
  await page.getByTestId("content-add-blog").click();
  await expect(page.getByTestId("content-message")).toContainText("Blog version added.");
  await expect(page.getByTestId("content-tab-blog")).toBeVisible();
  await page.getByTestId("content-body").fill("A blogváltozat hosszabb szövege.");
  await page.getByTestId("content-save").click();
  await expect(page.getByTestId("content-message")).toContainText("Saved.");

  await page.getByTestId("content-add-newsletter").click();
  await expect(page.getByTestId("content-message")).toContainText("Newsletter version added.");
  await expect(page.getByTestId("content-tab-newsletter")).toBeVisible();
  await page.getByTestId("content-body").fill("A hírlevélváltozat.");
  await page.getByTestId("content-save").click();
  await expect(page.getByTestId("content-message")).toContainText("Saved.");

  // THE POINT: still one card, now with three channels.
  const cards = page.locator('[data-testid="content-card"]', { hasText: title });
  await expect(cards).toHaveCount(1);

  // Each channel kept its own text.
  const variants = await prisma.contentVariant.findMany({
    where: { postId },
    orderBy: { channel: "asc" },
    select: { channel: true, body: true },
  });
  expect(variants).toEqual([
    { channel: "blog", body: "A blogváltozat hosszabb szövege." },
    { channel: "linkedin", body: "A LinkedIn változat szövege." },
    { channel: "newsletter", body: "A hírlevélváltozat." },
  ]);

  // And switching tabs shows the right one.
  await page.getByTestId("content-tab-linkedin").click();
  await expect(page.getByTestId("content-body")).toHaveValue("A LinkedIn változat szövege.");
  await page.getByTestId("content-tab-blog").click();
  await expect(page.getByTestId("content-body")).toHaveValue("A blogváltozat hosszabb szövege.");
});

test("the topic moves as one, and every channel has to be ready", async ({ page }) => {
  const title = `${PREFIX}gate ${Date.now()}`;
  const postId = await seed(title);
  const ws = await prisma.workspace.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  // A second channel with nothing in it.
  await prisma.contentVariant.create({
    data: { workspaceId: ws!.id, postId, channel: "newsletter", body: "" },
  });

  await page.goto("/content");
  await page.locator('[data-testid="content-card"]', { hasText: title }).click();
  await page.getByTestId("content-move-IN_REVIEW").click();

  // Refused, and it names the channel that is not ready.
  await expect(page.getByTestId("content-message")).toContainText(/Newsletter/i);
  const after = await prisma.contentPost.findUnique({
    where: { id: postId },
    select: { status: true },
  });
  expect(after?.status, "an empty channel got through review").toBe("DRAFT");
});
