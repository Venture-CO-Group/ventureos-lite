import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const ROOT = join(__dirname, "..", "..");

/**
 * Built, and reachable.
 *
 * ── WHAT THIS FOUND ────────────────────────────────────────────────────────
 *
 * A sweep of the codebase turned up twenty-one exported server actions that
 * nothing called, an audit log written in fifty-one places and read in none, a
 * `Target` table read twice and written never, and a complete keyword-tracking
 * component mounted on no page. None of it failed anything: it type-checked,
 * it linted, and the tests were green. That is the shape of this particular
 * decay — nothing breaks, the feature simply is not there.
 */

describe('"use server" files export only functions', () => {
  /**
   * The trap, twice now. A const exported from a `"use server"` file fails the
   * PRODUCTION build with "can only export async functions, found object" —
   * and passes typecheck, lint, and a cached local build.
   */
  /**
   * Files whose FIRST line is the directive. Grepping for the string matches
   * every comment that mentions it — including the comments warning about this
   * very trap.
   */
  const serverFiles = execSync('grep -rl \'"use server"\' src --include="*.ts"', {
    cwd: ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((rel) => readFileSync(join(ROOT, rel), "utf8").split("\n")[0]!.includes('"use server"'));

  it("finds the server files it means to check", () => {
    expect(serverFiles.length).toBeGreaterThan(20);
  });

  for (const rel of serverFiles) {
    it(`${rel} exports no value`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      const offenders = [
        ...src.matchAll(/^export (?!async function|type|interface)(const|let|var|class)\s+(\w+)/gm),
      ].map((m) => m[2]);
      expect(offenders, `${rel} exports ${offenders.join(", ")} — move it to a plain module`).toEqual([]);
    });
  }
});

describe("every exported server action has a caller", () => {
  /**
   * An action nothing calls is not a half-finished feature, it is maintenance
   * debt: it type-checks, no test covers it, and the next person to read it
   * assumes it works.
   */
  const actionFiles = execSync(
    'find src/modules -name "actions.ts" -o -name "*-actions.ts" | sort',
    { cwd: ROOT, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  const allSource = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) allSource.set(rel, readFileSync(join(ROOT, rel), "utf8"));
    }
  };
  walk("src");

  it("finds the action files it means to check", () => {
    expect(actionFiles.length).toBeGreaterThan(15);
  });

  for (const rel of actionFiles) {
    const src = allSource.get(rel) ?? "";
    const exported = [...src.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]!);
    for (const fn of exported) {
      it(`${rel} → ${fn} is called from somewhere`, () => {
        const callers = [...allSource.entries()].filter(
          ([path, text]) => path !== rel && new RegExp(`\\b${fn}\\b`).test(text),
        );
        expect(
          callers.length,
          `${fn} is exported and nothing references it — wire it up or delete it`,
        ).toBeGreaterThan(0);
      });
    }
  }
});

describe("what the database records, somebody can read", () => {
  const allText = execSync('find src -name "*.ts" -o -name "*.tsx"', {
    cwd: ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((f) => readFileSync(join(ROOT, f), "utf8"))
    .join("\n");

  /**
   * Hard rule #8 requires the audit log. It was written faithfully in
   * fifty-one places and read nowhere, which makes it a table rather than a
   * control.
   */
  it("the audit log is read, not only written", () => {
    expect(/auditLog\.(findMany|findFirst|count)/.test(allText)).toBe(true);
  });

  /** The Friday report compared four KPIs against targets nothing could set. */
  it("weekly targets can be written, not only read", () => {
    expect(/target\.(create|update|delete)/.test(allText)).toBe(true);
  });

  /** A complete rank-tracking feature was mounted on no page. */
  it("the search-visibility panel is mounted somewhere", () => {
    expect(/<SearchVisibility\b/.test(allText)).toBe(true);
  });

  /**
   * A panel that exists but is mounted nowhere is the same non-feature as one
   * that was never written — and the component name alone proves nothing, so
   * these assert the JSX tag.
   */
  it("the reader panels are mounted on a page", () => {
    expect(/<AuditLogPanel\b/.test(allText)).toBe(true);
    expect(/<SettingsTargets\b/.test(allText)).toBe(true);
    expect(/<SettingsAuditWatches\b/.test(allText)).toBe(true);
  });

  /** Watches are created by a job; there was no list and no off switch. */
  it("audit watches can be listed and stopped from the UI", () => {
    expect(/listAuditWatches\b/.test(allText)).toBe(true);
    expect(/clearAuditWatch\b/.test(allText)).toBe(true);
  });
});

/**
 * No client component reaches a server-only module.
 *
 * ── WHAT THIS FOUND ────────────────────────────────────────────────────────
 *
 * The access-review panel imported `DORMANT_DAYS` from the module that RUNS
 * the review, and the session TTLs from the module that OWNS the session
 * store. Both are inert numbers, both type-check perfectly — and both pull
 * `@/lib/db` → the tenant guard → the AsyncLocalStorage request context →
 * `node:async_hooks` into the browser bundle, which webpack refuses:
 *
 *   Module build failed: UnhandledSchemeError: Reading from "node:async_hooks"
 *   is not handled by plugins (Unhandled scheme).
 *
 * That is a DEV BUILD ERROR, and in dev it is sticky: once one route triggers
 * it the overlay replaces the app on every page. It cost a full e2e run —
 * thirteen failures across content, layout and duplicate-review, none of them
 * anywhere near the real cause, all of them just the error overlay where the
 * sidebar should have been. `tsc` cannot see it, lint cannot see it, and only
 * a production build or this test can.
 *
 * The fix is always the same shape: inert constants and types go in a module
 * with no imports (`review-logic.ts`, `session-policy.ts`, `invitation-logic.ts`),
 * and the module that does the work re-exports them for its own callers.
 *
 * ── WHY THE GRAPH AND NOT A GREP ───────────────────────────────────────────
 *
 * The offending import is never `node:async_hooks` — it is four hops away and
 * looks completely reasonable at the call site. Only the transitive graph
 * shows it.
 */
describe("the client bundle stays out of the server runtime", () => {
  const SRC = join(ROOT, "src");

  const files: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name)) files.push(p);
    }
  })(SRC);

  const text = new Map<string, string>();
  const read = (f: string) => {
    if (!text.has(f)) text.set(f, readFileSync(f, "utf8"));
    return text.get(f)!;
  };

  /** The directive, only when it is the first statement — a comment mentioning
   *  it does not make the file a boundary. */
  function directive(f: string): "use server" | "use client" | null {
    const m = read(f).match(/^\s*(?:\/\*[\s\S]*?\*\/\s*)?["'](use server|use client)["']/);
    return (m?.[1] as "use server" | "use client") ?? null;
  }

  function resolveSpec(spec: string, from: string): string | null {
    let base: string;
    if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
    else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
    else return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      if (existsSync(c) && statSync(c).isFile()) return c;
    }
    return null;
  }

  /**
   * Value imports only. `import type` and a clause whose every binding is
   * `type X` are erased by the compiler and cost the bundle nothing — counting
   * them would flag most of the codebase.
   */
  function valueImports(f: string): string[] {
    const src = read(f);
    const specs = new Set<string>();
    for (const m of src.matchAll(/^\s*import\s+([\s\S]*?)from\s*["']([^"']+)["']/gm)) {
      const clause = m[1];
      if (/^\s*type\s/.test(clause)) continue;
      const named = clause.match(/\{([\s\S]*)\}/);
      const alsoDefault = /^\s*[A-Za-z_$*]/.test(clause.replace(/\{[\s\S]*\}/, "").trim());
      if (named && !alsoDefault) {
        const parts = named[1].split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length === 0 || parts.every((p) => /^type\s/.test(p))) continue;
      }
      specs.add(m[2]);
    }
    for (const m of src.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) specs.add(m[1]);
    for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) specs.add(m[1]);
    for (const m of src.matchAll(/^\s*export\s+(?!type)[\s\S]*?from\s*["']([^"']+)["']/gm)) specs.add(m[1]);
    return [...specs].map((s) => (s.startsWith("node:") ? s : resolveSpec(s, f))).filter(Boolean) as string[];
  }

  /** Anything the browser cannot have. `node:crypto` and `node:fs` are the
   *  same class of mistake as `node:async_hooks`, just less likely. */
  const FORBIDDEN = /^node:/;

  function chainToServerRuntime(entry: string): string[] | null {
    const seen = new Set([entry]);
    const queue: [string, string[]][] = [[entry, [entry]]];
    while (queue.length) {
      const [f, path] = queue.shift()!;
      // Next replaces a `"use server"` module in the client graph with a proxy,
      // so its own imports never reach the browser. It is a real boundary.
      if (f !== entry && directive(f) === "use server") continue;
      for (const dep of valueImports(f)) {
        if (FORBIDDEN.test(dep)) return [...path, dep];
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push([dep, [...path, dep]]);
        }
      }
    }
    return null;
  }

  const clients = files.filter((f) => directive(f) === "use client");

  it("there are client components to check", () => {
    expect(clients.length).toBeGreaterThan(50);
  });

  it.each(clients.map((f) => [f.replace(`${ROOT}/`, ""), f] as const))(
    "%s imports nothing that needs Node",
    (_label, file) => {
      const chain = chainToServerRuntime(file);
      expect(
        chain === null,
        chain ? `client bundle reaches Node:\n  ${chain.map((p) => p.replace(`${ROOT}/`, "")).join("\n  -> ")}` : "",
      ).toBe(true);
    },
  );
});
