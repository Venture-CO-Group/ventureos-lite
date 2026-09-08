import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../..");
const SCRIPT = join(ROOT, "scripts/restore-drill.sh");
const src = readFileSync(SCRIPT, "utf8");

/**
 * The restore drill (P5/5.4).
 *
 * `scripts/backup.sh` has run nightly for weeks and there are fifty dumps on
 * the server. Nobody had ever restored one — and an untested backup is a file
 * of the right size in the right place, which feels identical to a backup right
 * up until the morning it matters.
 *
 * The script runs against a production database as the superuser, so what is
 * tested here is the part that must never be wrong: that it cannot touch the
 * live database, and that it never destroys anything it did not create.
 */
describe("the drill script is syntactically sound", () => {
  it("parses", () => {
    // A shell script with a typo fails at 4am in a cron log nobody reads.
    expect(() => execFileSync("bash", ["-n", SCRIPT], { stdio: "pipe" })).not.toThrow();
  });

  it("is executable", () => {
    // Committed with the bit set, or the cron line silently does nothing.
    expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
  });

  it("aborts on any failing command", () => {
    expect(src).toContain("set -Eeuo pipefail");
  });
});

describe("it cannot become the incident it exists to prevent", () => {
  it("refuses to run when the scratch name is the live database", () => {
    expect(src).toContain('[ "$DRILL_DB" != "$POSTGRES_DB" ]');
  });

  it("refuses any scratch name that is not obviously a scratch name", () => {
    // Belt and braces: even a POSTGRES_DB left unset cannot let a DROP land on
    // something real, because the name has to end in _restore_drill.
    expect(src).toContain("*_restore_drill) : ;;");
    expect(src).toMatch(/refusing to touch/);
  });

  it("only ever drops the database it created", () => {
    const drops = src.match(/DROP DATABASE[^\n]*/g) ?? [];
    expect(drops.length).toBeGreaterThan(0);
    for (const d of drops) expect(d).toContain('\\"$DRILL_DB\\"');
  });

  it("creates only that database", () => {
    const creates = src.match(/CREATE DATABASE[^\n]*/g) ?? [];
    for (const c of creates) expect(c).toContain('\\"$DRILL_DB\\"');
  });

  it("never deletes a backup file", () => {
    // Rotation is backup.sh's job. A drill that can delete the artefact it is
    // inspecting is one bad variable away from deleting the lot.
    expect(src).not.toMatch(/-delete/);
    expect(src).not.toMatch(/\brm\s+-/);
  });

  it("lists the files archive rather than extracting it", () => {
    // Extracting over the live volume during a drill is exactly the outage the
    // drill is meant to prevent.
    expect(src).toContain("tar -tzf");
    expect(src).not.toContain("tar -xzf");
  });
});

describe("it actually checks something", () => {
  it("fails the restore loudly rather than reporting a green empty schema", () => {
    // pg_restore into an empty database exits zero. The counts are the test.
    expect(src).toContain("--exit-on-error");
    expect(src).toContain("THE BACKUP IS NOT A BACKUP");
    expect(src).toContain("information_schema.tables");
  });

  it("requires the rows without which nobody could log in to a restored system", () => {
    expect(src).toContain("check_rows workspaces 1");
    expect(src).toContain("check_rows users 1");
  });

  it("checks the freshness of the data, not only of the file", () => {
    // A dump can be an hour old and hold a week-old snapshot.
    expect(src).toContain("newest backup is");
    expect(src).toContain("FROM audit_logs");
  });

  it("checks the RLS policies, which are half of the tenancy promise", () => {
    expect(src).toContain("pg_policies");
    expect(src).toContain("npm run rls:apply");
  });

  it("exits non-zero when a check failed, so cron can notice", () => {
    expect(src).toMatch(/problems.*-gt 0/);
    expect(src).toContain("exit 1");
  });
});

describe("the procedure is written down", () => {
  const doc = readFileSync(join(ROOT, "docs/restore-drill.md"), "utf8");

  it("tells the reader to rename the live database rather than drop it", () => {
    // The one instruction that decides whether a botched restore is recoverable.
    expect(doc).toContain("RENAME TO ventureos_before_restore");
    expect(doc).toContain("nem eldobjuk");
  });

  it("explains every failure the script can print", () => {
    for (const phrase of [
      "pg_restore could not load the dump",
      "only N tables in the restored database",
      "no files archive found",
      "row-level-security policies restored: 0",
    ]) {
      expect(doc).toContain(phrase);
    }
  });

  it("is reachable from the deployment guide", () => {
    const deploy = readFileSync(join(ROOT, "docs/DEPLOY.md"), "utf8");
    expect(deploy).toContain("restore-drill.sh");
    expect(deploy).toContain("restore-drill.md");
  });

  it("keeps a log of the drills that were run", () => {
    // An undocumented drill is one nobody can prove happened.
    expect(doc).toContain("A próbák naplója");
  });
});
