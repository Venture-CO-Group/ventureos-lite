import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { DESTRUCTIVE_ACTIONS, undoabilityOf } from "../../src/modules/undo/contract";

const ROOT = join(__dirname, "..", "..");

/**
 * Every destructive action declares an inverse or a reason (playbook-v5 P16/3).
 *
 * ── WHY THIS TEST IS THE FEATURE ───────────────────────────────────────────
 *
 * The playbook asks for "a typed contract so every new destructive action must
 * declare either an inverse or an explicit reason it cannot be undone". A type
 * alone cannot enforce that, because nothing forces a new function to be
 * mentioned in the registry at all. This test is what turns "must" into
 * something the build can check: it finds the destructive exports itself and
 * fails on any that is missing, naming it.
 *
 * It reads the codebase rather than importing it, deliberately — importing
 * `*-actions.ts` would drag Auth.js and next/server into a unit test.
 */
describe("the destructive-action contract", () => {
  /** The verbs that mean "something the user cannot get back by re-typing it". */
  const VERBS = "delete|archive|remove|purge|discard|clear|dismiss|wipe";

  const found = execSync(
    `grep -rhoE "export async function (${VERBS})[A-Za-z]+" src/modules/ | sed 's/export async function //' | sort -u`,
    { cwd: ROOT, encoding: "utf8", shell: "/bin/bash" },
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  it("finds the destructive exports to check", () => {
    expect(found.length).toBeGreaterThan(20);
  });

  it.each(found)("%s declares its undoability", (name) => {
    const declared = undoabilityOf(name);
    expect(
      declared !== null,
      `${name} is destructive but not declared in src/modules/undo/contract.ts. ` +
        `Add either { undoable: true, kind } — and record the inverse — or ` +
        `{ undoable: false, reason } with the sentence a user should read before clicking.`,
    ).toBe(true);
  });

  /**
   * A registry that has drifted the other way is also wrong: an entry for a
   * function that no longer exists is a reason nobody will ever read, and it
   * hides the fact that the action was renamed rather than declared.
   */
  it("has no entries for actions that no longer exist", () => {
    const stale = Object.keys(DESTRUCTIVE_ACTIONS).filter((k) => !found.includes(k));
    expect(stale, `stale entries: ${stale.join(", ")}`).toEqual([]);
  });

  describe("the declarations themselves", () => {
    it("a reason is a sentence, not a shrug", () => {
      for (const [name, decl] of Object.entries(DESTRUCTIVE_ACTIONS)) {
        if (decl.undoable) continue;
        // It is shown to a person about to do something irreversible, so it has
        // to say what goes and be written in words.
        expect(decl.reason.length, name).toBeGreaterThan(30);
        expect(decl.reason.trim().endsWith("."), `${name}: reason should be a sentence`).toBe(true);
        expect(/^[A-Z]/.test(decl.reason), `${name}: reason should start capitalised`).toBe(true);
      }
    });

    /**
     * An inverse may only be claimed for an entity the engine can actually put
     * back. Claiming one it cannot is worse than claiming none: `undo` skips
     * rows it cannot find and reports success, so the person is told their
     * action was reversed when nothing happened.
     */
    it("every claimed inverse names a kind the engine knows", async () => {
      const store = await import("../../src/modules/undo/store");
      const kinds = new Set(
        execSync(`sed -n '/export type UndoKind/,/;/p' src/modules/undo/store.ts`, {
          cwd: ROOT,
          encoding: "utf8",
          shell: "/bin/bash",
        })
          .match(/"[a-z_]+"/g)
          ?.map((s) => s.replaceAll('"', "")) ?? [],
      );
      expect(kinds.size).toBeGreaterThan(5);
      expect(typeof store.recordUndo).toBe("function");
      for (const [name, decl] of Object.entries(DESTRUCTIVE_ACTIONS)) {
        if (!decl.undoable) continue;
        expect(kinds.has(decl.kind), `${name} claims unknown kind "${decl.kind}"`).toBe(true);
      }
    });

    /**
     * And the claim has to be backed by a real `recordUndo` call. A declaration
     * without one is the lie this file exists to prevent.
     */
    it("every claimed inverse is actually recorded somewhere", () => {
      const recorded = execSync(`grep -rhoE 'kind: "[a-z_]+"' src/modules/ | sort -u`, {
        cwd: ROOT,
        encoding: "utf8",
        shell: "/bin/bash",
      });
      for (const [name, decl] of Object.entries(DESTRUCTIVE_ACTIONS)) {
        if (!decl.undoable) continue;
        expect(
          recorded.includes(`kind: "${decl.kind}"`),
          `${name} claims kind "${decl.kind}" but nothing calls recordUndo with it`,
        ).toBe(true);
      }
    });
  });
});
