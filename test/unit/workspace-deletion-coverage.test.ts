import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A deleted workspace must stop being swept the moment it is deleted.
 *
 * Deletion is two-step: `deletedAt` hides it, the purge erases it a month
 * later. In between, any background job that iterates workspaces without
 * filtering `deletedAt` would keep emailing digests and — worse — sending
 * outbound mail for a company the Owner has deleted. So every iteration over
 * workspaces must carry the filter, and this test is what keeps a job written
 * next month from forgetting it.
 */
const ROOT = join(__dirname, "..", "..", "src");

/** The one module that deliberately reads deleted workspaces. */
const ALLOWED = new Set([
  "modules/workspaces/admin.ts", // restore list and the purge itself
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("every sweep over workspaces skips deleted ones", () => {
  it("filters deletedAt in every prismaUnsafe.workspace.findMany", () => {
    const offenders: string[] = [];
    for (const file of files(ROOT)) {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      let at = src.indexOf("prismaUnsafe.workspace.findMany(");
      while (at >= 0) {
        // The argument object, up to its closing paren — enough to see a where.
        const call = src.slice(at, src.indexOf(");", at) + 2);
        if (!/deletedAt/.test(call)) {
          offenders.push(`${rel}:${src.slice(0, at).split("\n").length}`);
        }
        at = src.indexOf("prismaUnsafe.workspace.findMany(", at + 1);
      }
    }
    expect(offenders).toEqual([]);
  });
});
