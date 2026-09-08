import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const EMAILS = ["members-a@ventureco.test", "members-b@ventureco.test", "members-c@ventureco.test"];
const TEAM = "E2E Members Team";
let workspaceId = "";
const ids: string[] = [];

test.beforeAll(async () => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  workspaceId = ws!.id;
  await cleanup();

  const team = await prisma.team.create({
    data: { workspaceId, name: TEAM, color: "#3DDC97" },
  });

  for (const [i, email] of EMAILS.entries()) {
    const user = await prisma.user.create({
      data: { email, name: `Member ${"ABC"[i]}`, passwordHash: "x" },
    });
    ids.push(user.id);
    await prisma.membership.create({
      data: { userId: user.id, workspaceId, role: "BDR", grants: [], state: "ACTIVE" },
    });
    // Only the first is on the team, so the filter has something to exclude.
    if (i === 0) {
      await prisma.teamMember.create({
        data: { workspaceId, teamId: team.id, userId: user.id, isLead: true },
      });
    }
  }
});

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: EMAILS } } });
  for (const u of users) {
    await prisma.teamMember.deleteMany({ where: { userId: u.id } });
    await prisma.membershipEvent.deleteMany({ where: { userId: u.id } });
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.membership.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }
  await prisma.teamMember.deleteMany({ where: { team: { name: TEAM } } });
  await prisma.team.deleteMany({ where: { name: TEAM } });
}

test.afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function open(page: import("@playwright/test").Page) {
  await page.goto("/settings/admin/members");
  await expect(page.getByTestId("settings-users")).toBeVisible({ timeout: 30_000 });
}

/**
 * The members screen (§3).
 *
 * A proper table, not a list: the columns that make it usable are the teams
 * and the state, and the two controls that make it a management surface are
 * bulk selection and the detail drawer.
 */
test("the table shows teams and the membership state", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId(`user-teams-${ids[0]}`)).toContainText(TEAM);
  // A team lead is marked, because "who do I escalate to" is the question a
  // team column gets asked.
  await expect(page.getByTestId(`user-teams-${ids[0]}`)).toContainText("★");
  await expect(page.getByTestId(`user-teams-${ids[1]}`)).toContainText("—");
});

test("filtering by team narrows the table", async ({ page }) => {
  await open(page);
  const teamOption = page.getByTestId("filter-team");
  await expect(teamOption).toBeVisible();
  await teamOption.selectOption({ label: TEAM });

  await expect(page.getByTestId(`select-${ids[0]}`)).toBeVisible();
  await expect(page.getByTestId(`select-${ids[1]}`)).toHaveCount(0);
});

test("filtering by role narrows the table", async ({ page }) => {
  await open(page);
  await page.getByTestId("filter-role").selectOption("CLIENT");
  // Nobody in this fixture is a client.
  for (const id of ids) await expect(page.getByTestId(`select-${id}`)).toHaveCount(0);
});

test("the drawer resolves permissions from the grants model, and shows a timeline", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId(`open-member-${ids[1]}`).click();
  await expect(page.getByTestId("member-drawer")).toBeVisible();

  /**
   * The assertion that matters: these lines are computed, not written down.
   *
   * A BDR carries everything except the five document and template
   * capabilities — so `exports.run` is theirs by role and `templates.edit` is
   * not. If the drawer described permissions in prose it would disagree with
   * the server the first time the model changed, and nobody would notice.
   */
  const perms = page.getByTestId("drawer-permissions");
  await expect(perms).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("perm-exports.run")).toContainText("carries it as BDR");
  await expect(page.getByTestId("perm-templates.edit")).toContainText("not granted");

  // Nothing has happened to this person yet, and the drawer says so rather
  // than showing an empty box.
  await expect(page.getByTestId("member-drawer")).toContainText("Nothing recorded yet");
});

test("a bulk role change reports every row, including the ones it refused", async ({ page }) => {
  await open(page);
  await page.getByTestId(`select-${ids[0]}`).check();
  await page.getByTestId(`select-${ids[1]}`).check();
  await expect(page.getByTestId("bulk-count")).toContainText("2 selected");

  await page.getByTestId("bulk-action").selectOption("role");
  await page.getByTestId("bulk-role").selectOption("ADMIN");
  await page.getByTestId("bulk-apply").click();

  /**
   * A bulk operation must never partially apply silently.
   *
   * Both rows are on screen with their outcome, which is what stops "9
   * changed, 3 refused" from being the whole story.
   */
  await expect(page.getByTestId("bulk-report")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("bulk-report-row")).toHaveCount(2);

  for (const id of ids.slice(0, 2)) {
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: id, workspaceId } });
    expect(m.role).toBe("ADMIN");
  }
  // Every change is on the timeline, with the actor.
  const events = await prisma.membershipEvent.findMany({
    where: { workspaceId, userId: { in: ids.slice(0, 2) }, kind: "role_changed" },
  });
  expect(events).toHaveLength(2);
  expect(events[0]!.actorUserId).toBeTruthy();

  // Put them back for the next test.
  await prisma.membership.updateMany({
    where: { userId: { in: ids.slice(0, 2) }, workspaceId },
    data: { role: "BDR" },
  });
});

test("a bulk suspend revokes sessions and refuses to touch yourself", async ({ page }) => {
  // A live session for the member about to be stood down.
  await prisma.session.create({
    data: {
      userId: ids[2]!,
      workspaceId,
      token: `e2e-bulk-${Date.now()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  await open(page);
  await page.getByTestId(`select-${ids[2]}`).check();
  // And the Owner running the test, who must be refused.
  const runner = await prisma.user.findUniqueOrThrow({
    where: { email: "e2e-runner@ventureco.test" },
  });
  await page.getByTestId(`select-${runner.id}`).check();

  await page.getByTestId("bulk-action").selectOption("suspend");
  await page.getByTestId("bulk-apply").click();
  await expect(page.getByTestId("bulk-report")).toBeVisible({ timeout: 20_000 });

  // One done, one refused — and the refusal says why rather than vanishing.
  await expect(page.getByTestId("bulk-report")).toContainText("refused");
  await expect(page.getByTestId("bulk-report")).toContainText("cannot suspend yourself");

  const suspended = await prisma.membership.findFirstOrThrow({
    where: { userId: ids[2], workspaceId },
  });
  expect(suspended.state).toBe("SUSPENDED");
  // Suspension bites now, not when the token expires.
  const live = await prisma.session.count({
    where: { userId: ids[2], revokedAt: null, expiresAt: { gt: new Date() } },
  });
  expect(live).toBe(0);
  // And the role they had is stored, so reinstating gives back exactly that.
  expect(suspended.suspendedRole).toBe("BDR");

  // The Owner is untouched.
  const owner = await prisma.membership.findFirstOrThrow({
    where: { userId: runner.id, workspaceId },
  });
  expect(owner.state).toBe("ACTIVE");
});

test("reinstating restores the role that was stored", async ({ page }) => {
  await open(page);
  await page.getByTestId(`select-${ids[2]}`).check();
  await page.getByTestId("bulk-action").selectOption("reinstate");
  await page.getByTestId("bulk-apply").click();
  await expect(page.getByTestId("bulk-report")).toBeVisible({ timeout: 20_000 });

  const back = await prisma.membership.findFirstOrThrow({
    where: { userId: ids[2], workspaceId },
  });
  expect(back.state).toBe("ACTIVE");
  expect(back.role).toBe("BDR");
  // Cleared, so a later suspension stores fresh values rather than stale ones.
  expect(back.suspendedRole).toBeNull();
});
