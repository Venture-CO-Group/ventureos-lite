import { PrismaClient } from "@prisma/client";
import { resolveTestEnv } from "./helpers/env";

/**
 * Apply the row-level-security policies ONCE for the whole run.
 *
 * Two test files need them and both used to apply them in `beforeAll`. Vitest
 * runs files in parallel workers, so `DROP POLICY` from one raced the other's
 * live queries — a failure that only appeared in the full suite and never when
 * either file was run alone, which is the most expensive kind.
 */
export default async function setup(): Promise<void> {
  /**
   * The global setup runs in the Vitest MAIN process, where `test.env` from the
   * config has not been applied — so it saw `.env`'s container database URL and
   * warned that it could not connect, on every local run. A green isolation
   * suite that never applied a policy is worse than a red one.
   */
  const env = resolveTestEnv();
  if ((env.DB_FLAVOR ?? "postgres") !== "postgres") return;
  if (!env.DATABASE_URL) return;

  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try {
    const { applyRls } = await import("../src/lib/rls");
    await applyRls(prisma);
  } catch (e) {
    // Not fatal: a machine without a database still runs the unit suite, and
    // the DB-backed files fail loudly on their own if they cannot connect.
    // eslint-disable-next-line no-console
    console.warn("[test] could not apply RLS policies:", (e as Error).message);
  } finally {
    await prisma.$disconnect();
  }
}
