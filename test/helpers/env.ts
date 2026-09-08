import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `.env` first, then `.env.local` on top — the precedence Next.js itself uses.
 *
 * ── WHY THIS IS SHARED RATHER THAN INLINE ───────────────────────────────────
 *
 * `.env` holds the CONTAINER values: `DATABASE_URL` names the compose service
 * and `FILES_DIR` is `/data/files`. Neither resolves on a developer machine,
 * where the host-side ports live in `.env.local`.
 *
 * The Vitest config read only `.env`, so every DB-backed test failed with
 * "authentication failed against database server" unless each variable was
 * exported by hand first. Worse, the RLS global setup read it too and quietly
 * warned rather than failing — so a local run of the isolation suite could
 * report green having never applied a single policy.
 *
 * One parser, used by both, so those two cannot drift apart again.
 */
export function parseEnvFile(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const raw = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      env[key] = value;
    }
  } catch {
    // absent — a caller that needs it fails loudly on its own
  }
  return env;
}

export function loadTestEnv(): Record<string, string> {
  return { ...parseEnvFile(".env"), ...parseEnvFile(".env.local") };
}

/**
 * The same thing for a process that has already imported `@prisma/client`.
 *
 * Importing the Prisma client LOADS `.env` into `process.env` as a side effect.
 * So in the Vitest global setup — which imports it at the top of the file —
 * `process.env.DATABASE_URL` is already `.env`'s container value by the time
 * anything else runs, and a plain `{ ...files, ...process.env }` hands that
 * value straight back. The RLS setup warned "authentication failed" on every
 * local run because of exactly this.
 *
 * The order below says what is actually meant:
 *
 *   `.env`  — the committed defaults, and whatever Prisma smuggled in;
 *   process — an explicit `FOO=bar npx vitest`, which should still win;
 *   `.env.local` — this developer's machine, which is the most specific fact
 *                  there is and is gitignored precisely because of that.
 */
export function resolveTestEnv(): Record<string, string | undefined> {
  return { ...parseEnvFile(".env"), ...process.env, ...parseEnvFile(".env.local") };
}
