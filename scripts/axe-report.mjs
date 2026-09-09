/**
 * axe on the six busiest screens (playbook-v5 P16/4).
 *
 * A script rather than a spec because it produces a REPORT — the before/after
 * list the playbook asks for. The permanent guard is e2e/a11y.spec.ts, which
 * fails the build on a serious or critical violation; this is the thing you run
 * to see what is there.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const AXE = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
const BASE = process.env.APP_URL ?? "http://localhost:3000";

/** The six busiest, by what a BDR actually opens in a day. */
const SCREENS = [
  ["dashboard", "/"],
  ["leads", "/leads"],
  ["pipeline", "/pipeline"],
  ["tasks", "/tasks"],
  ["inbox", "/inbox"],
  ["audit", "/audit"],
];

const browser = await chromium.launch();
const context = await browser.newContext({ storageState: "e2e/.auth/state.json" });
const page = await context.newPage();

let total = 0;
const rows = [];

for (const [name, path] of SCREENS) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  // Let the Suspense bodies resolve so the real content is what gets scanned.
  await page.waitForTimeout(1200);
  await page.evaluate(AXE);
  const result = await page.evaluate(async () => {
    // @ts-expect-error injected
    return await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  });

  const violations = result.violations.filter((v) => v.impact !== "minor");
  total += violations.reduce((n, v) => n + v.nodes.length, 0);
  console.log(`\n=== ${name} (${path}) ===`);
  if (violations.length === 0) {
    console.log("  no serious or critical violations");
  }
  for (const v of violations) {
    console.log(`  [${v.impact}] ${v.id} × ${v.nodes.length} — ${v.help}`);
    for (const node of v.nodes.slice(0, 3)) {
      console.log(`      ${node.target.join(" ")}`.slice(0, 150));
    }
    rows.push({ screen: name, id: v.id, impact: v.impact, count: v.nodes.length });
  }
}

console.log(`\nTOTAL serious+critical nodes: ${total}`);
await browser.close();
