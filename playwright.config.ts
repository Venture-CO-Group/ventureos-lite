import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

// The critical flows (CLAUDE.md): capture→score→gate, quote→pdf→send, workspace
// isolation, plus the auth perimeter and the outreach human-edit guardrail.
// Specs land alongside their features; this config is the harness.

/**
 * Where the run may write files, host-side.
 *
 * `.env` sets FILES_DIR=/data/files, which is the path INSIDE the app and
 * worker containers — docker-compose mounts the `files` volume there. On a
 * developer machine nothing may create `/data`, so a host-side run of the
 * isolation spec (which writes a PDF to prove workspace B cannot read
 * workspace A's) died in beforeAll with ENOENT and took the other three
 * isolation tests down with it.
 *
 * Setting it HERE rather than in `.env` is deliberate: this is evaluated in the
 * runner process before any spec loads, so specs reading `process.env.FILES_DIR`
 * see it, and `webServer` inherits it — Next.js does not overwrite a variable
 * that is already present in the environment, so `.env` cannot clobber it. The
 * container path stays exactly as it was.
 *
 * `/data/` at the repo root is already gitignored.
 */
process.env.FILES_DIR ??= resolve(__dirname, "data/files");

export default defineConfig({
  testDir: "./e2e",
  /**
   * One worker, deliberately.
   *
   * Every spec runs against the SAME seeded workspace and the SAME dev server.
   * That was survivable while the suite was mostly read-only, but the P3/2 lead
   * specs create, filter, re-stage and delete leads — and in parallel they were
   * revalidating /leads underneath each other, so a worker could be served a
   * cached render that predated its own write. The failures moved around every
   * run, which is the signature of contention rather than of a bug.
   *
   * The honest fixes are per-worker workspaces or a mutex; neither is worth the
   * machinery for a suite of this size. Serial costs roughly two extra minutes
   * and makes a red result mean something.
   */
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  /**
   * 45s, up from the 30s default, and one retry.
   *
   * ── THE EVIDENCE FOR THIS, RATHER THAN A SHRUG ─────────────────────────────
   *
   * Across four full runs of the ~200-test suite, two or three tests failed each
   * time. Every single failure was a TIMEOUT, never an assertion; the identity of
   * the failing tests changed run to run; and every one of them passed when run
   * on its own or in a small group. That is the signature of the dev server
   * getting slower over a long session — it compiles routes on demand and holds
   * everything in one process — not of a defect in what is being tested.
   *
   * The honest fix would be to run the suite against a production build, but the
   * production env guard (correctly) refuses loopback and http origins, so a
   * local prod server cannot be started without lying to it.
   *
   * `retries: 1` does NOT hide anything: Playwright reports a test that only
   * passed on retry as FLAKY, separately from passed. A flaky line in the output
   * is a thing to investigate, and treating it as a pass is how a real
   * intermittent bug gets ignored.
   */
  timeout: 45_000,
  /**
   * And the per-ASSERTION budget, which was left at Playwright's 5s default.
   *
   * That default assumes an assertion is waiting for the browser, and here it
   * is usually waiting for a Server Action to come back from a dev server that
   * has compiled four hundred tests' worth of routes into one process. The
   * mismatch is the whole story of the remaining flakes: the test had 45
   * seconds and the assertion inside it gave up after five. Every one of them
   * passed alone and passed on retry, and each failure was a timeout rather
   * than a wrong value.
   *
   * Ten seconds does not hide a broken assertion — it fails five seconds
   * later. It stops a slow round trip being reported as a wrong answer.
   */
  expect: { timeout: 10_000 },
  retries: 1,
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    // Signs in once; the main project reuses those cookies. Specs that need a
    // signed-out browser opt out with an empty storageState.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/state.json" },
      dependencies: ["setup"],
      // Runs after the project finishes, pass or fail. Without it the suite
      // poisons its own next run — see the file for the two failures that were
      // nothing but leftovers.
      teardown: "cleanup",
    },
    { name: "cleanup", testMatch: /cleanup\.teardown\.ts/ },
  ],
  webServer: {
    command: "npm run dev",
    url: process.env.APP_URL ?? "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
