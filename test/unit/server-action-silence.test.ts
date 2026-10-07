import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attempt,
  attemptVoid,
  isStaleDeployment,
  serverActionError,
  STALE_DEPLOYMENT_MESSAGE,
} from "../../src/lib/client/server-action";
import { stripComments } from "../helpers/strip-comments";

const ROOT = join(__dirname, "..", "..");

/**
 * The silence that looked like a broken button.
 *
 * ── THE REPORTED PROBLEM ────────────────────────────────────────────────────
 *
 *   "Lead szerkesztésekor a mentés nem megy"  — Save does nothing
 *   "Run research nem csinál semmit"          — Run research does nothing
 *
 * Neither was a dead button and neither was a refusal. Both were an UNEXPECTED
 * throw inside a Server Action, and Next.js redacts those in production: the
 * client receives an Error whose `message` is EMPTY and whose only content is a
 * `digest`. Two ways that reached the operator as nothing at all:
 *
 *   1. No catch — the rejection inside `startTransition` went nowhere, the
 *      button flipped back from "Saving…", and no message was ever set.
 *   2. `setError((e as Error).message)` — an empty string, and the error strip
 *      is rendered as `{error && …}`, so an empty string renders nothing.
 *
 * The first is why the save was silent; the second is why research was. They
 * are the same bug with two spellings.
 */
describe("an unexpected throw always produces something readable", () => {
  it("turns a redacted production error into a message with its digest", () => {
    const redacted = Object.assign(new Error(""), { digest: "1234567890abcdef" });
    const text = serverActionError(redacted);
    expect(text.length).toBeGreaterThan(0);
    // The digest is the only handle that ties what the operator saw to the
    // server log line. It is a hash, which is why Next.js sends it at all.
    expect(text).toContain("1234567890ab");
  });

  it("never returns an empty string, whatever it is handed", () => {
    for (const thrown of [new Error(""), new Error("boom"), null, undefined, "", 0, {}]) {
      expect(serverActionError(thrown).trim().length).toBeGreaterThan(0);
    }
  });

  it("says so plainly when the network is the problem", () => {
    expect(serverActionError(new TypeError("Failed to fetch"))).toMatch(/reach the server/i);
  });

  it("keeps the real message in development, where there is one", () => {
    expect(serverActionError(new Error("Company not found"))).toContain("Company not found");
  });
});

describe("attempt", () => {
  it("passes a successful result through untouched", async () => {
    const value = { ok: true as const, id: "x" };
    expect(await attempt(Promise.resolve(value))).toBe(value);
  });

  it("passes a REFUSAL through untouched — refusals are data, not failures", async () => {
    const refusal = { ok: false as const, error: "Check the values and try again." };
    expect(await attempt(Promise.resolve(refusal))).toBe(refusal);
  });

  it("converts a throw into the same shape every caller already handles", async () => {
    const res = await attempt(Promise.reject(Object.assign(new Error(""), { digest: "abc123" })));
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/abc123/);
  });

  /**
   * `redirect()` signals by throwing. Swallowing it would strand the user on a
   * page they were being moved off — a revoked session would silently do
   * nothing instead of showing the login form.
   */
  it("re-throws a redirect instead of swallowing it", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    await expect(attempt(Promise.reject(redirect))).rejects.toBe(redirect);
  });

  it("attemptVoid gives back the error text, or null on success", async () => {
    expect(await attemptVoid(Promise.resolve(1))).toBeNull();
    expect(await attemptVoid(Promise.reject(new Error("nope")))).toContain("nope");
  });
});

/**
 * Source-level, because the bug was not in a function — it was in the ABSENCE
 * of one at each call site. A test that only exercises the helper would have
 * passed on the broken code.
 */
describe("the reported call sites no longer swallow a throw", () => {
  const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));

  it("the lead modal wraps its save", () => {
    const src = read("src/components/lead-detail-modal.tsx");
    expect(src).toMatch(/attempt\(\s*updateLeadDetail\(/);
  });

  it("the leads table wraps its research", () => {
    const src = read("src/components/leads-table.tsx");
    expect(src).toMatch(/attempt\(runResearch\(/);
    // The old spelling, which rendered an empty string.
    expect(src).not.toMatch(/setError\(\(e as Error\)\.message\)/);
  });

  it("the audit runner reports a rejected URL instead of nothing", () => {
    const src = read("src/components/audit-runner.tsx");
    expect(src).toMatch(/serverActionError\(e\)/);
    expect(src).not.toMatch(/setError\(\(e as Error\)\.message\)/);
  });

  /**
   * NO FIRE-AND-FORGET ACTION CALLS.
   *
   * The audit's second sweep: 36 places awaited a Server Action and threw the
   * result away. 22 of them were not inside a try/catch either, so a failure
   * produced NOTHING — a revoked capture token that was never revoked, a
   * mailbox believed disconnected, a template version believed active while
   * legal documents still rendered from the previous one, a workspace switch
   * that left you in the old workspace believing you had moved.
   *
   * Four panels had nowhere at all to report a failure and gained one.
   *
   * The two exceptions are in `onboarding.tsx` and carry an explicit `.catch()`
   * plus the reason: if marking a tour finished fails, the tour reappears, which
   * is its own error message.
   */
  it("no component awaits a server action and discards the outcome", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const files = execSync("ls src/components/*.tsx", { encoding: "utf8" }).split("\n").filter(Boolean);
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      const src = lines.join("\n");
      const actions = new Set<string>();
      for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/modules\/[^"]+"/g)) {
        for (const part of m[1]!.split(",")) {
          const name = part.trim().replace("type ", "");
          if (name && /^[a-z]/.test(name)) actions.add(name);
        }
      }
      lines.forEach((line, i) => {
        const m = /^\s*await ([A-Za-z_$][\w$]*)\(/.exec(line);
        if (!m || !actions.has(m[1]!) || line.includes(".catch(")) return;
        // Inside a try block? Then the file's catch reports it.
        let depth = 0;
        for (let j = i; j >= Math.max(0, i - 30); j -= 1) {
          const l = lines[j]!;
          if (/\}\s*catch/.test(l)) depth += 1;
          if (/\btry\s*\{/.test(l)) {
            if (depth === 0) return;
            depth -= 1;
          }
        }
        offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders, `silent action calls: ${offenders.join(", ")}`).toEqual([]);
  });

  /**
   * The same silence, spelled `return` instead of `await`.
   *
   * `saveCell` in the leads table was `return editLeadField({...})` — a bare
   * action promise handed to `InlineCell`, which does `await onSave(next)` and
   * then `setSaving(false)`. A throw skipped that line entirely: the cell sat in
   * its saving state for ever, showed nothing, and kept the edit. The refusals
   * had always been handled; the unexpected failures had nowhere to land.
   *
   * The action names come from the files that actually carry the directive, so
   * a pure helper imported from a module cannot be mistaken for one.
   */
  it("no component returns a bare server-action promise", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const serverFiles = execSync('grep -rl \'"use server"\' src --include="*.ts"', {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((rel) => readFileSync(join(ROOT, rel), "utf8").split("\n")[0]!.includes('"use server"'));

    const actionNames = new Set<string>();
    for (const rel of serverFiles) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const m of text.matchAll(/^export async function (\w+)/gm)) actionNames.add(m[1]!);
    }
    expect(actionNames.size).toBeGreaterThan(50);

    const files = execSync("ls src/components/*.tsx", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = /^\s*return ([A-Za-z_$][\w$]*)\(/.exec(line);
          if (m && actionNames.has(m[1]!)) offenders.push(`${file}:${i + 1} (${m[1]})`);
        });
    }
    expect(offenders, `unwrapped action promises: ${offenders.join(", ")}`).toEqual([]);
  });

  /**
   * A guard against the pattern coming back somewhere else. `.message` on a
   * caught Server Action error is empty in production, and `{x && …}` renders
   * nothing for an empty string — so this spelling is always a silent failure.
   */
  it("no component renders a caught action's bare .message any more", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const hits = execSync(
      "grep -rln 'set[A-Za-z]*((e as Error).message)' src/components src/app || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(hits, `still swallowing: ${hits.join(", ")}`).toEqual([]);
  });
});

/**
 * A tab opened before a deploy (the "Create workspace does nothing" report).
 *
 * The server log said `Failed to find Server Action`; the client threw an
 * `UnrecognizedActionError` with no digest. The operator must be told to
 * reload, not shown a reference into a log that has nothing to add.
 */
describe("a page older than the deployment says so", () => {
  it("recognises Next's UnrecognizedActionError by name", () => {
    const e = Object.assign(new Error("x"), { name: "UnrecognizedActionError" });
    expect(isStaleDeployment(e)).toBe(true);
    expect(serverActionError(e)).toBe(STALE_DEPLOYMENT_MESSAGE);
  });

  it("recognises it by message when the class name was minified away", () => {
    const e = new Error(
      'Server Action "00a1b472c3c94eb601616d9bb4d55d608dbdf52ada" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    );
    expect(isStaleDeployment(e)).toBe(true);
    expect(serverActionError(e)).toMatch(/reload/i);
  });

  it("does not mistake an ordinary failure for a stale page", () => {
    expect(isStaleDeployment(new Error("boom"))).toBe(false);
    expect(isStaleDeployment(null)).toBe(false);
  });
});
