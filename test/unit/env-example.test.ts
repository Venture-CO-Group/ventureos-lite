import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { validateEnv } from "../../src/lib/env";

/**
 * .env.production.example is a deliverable, not documentation that drifts.
 *
 * These tests keep it honest in both directions:
 *   - every variable the code reads is present in the example, and
 *   - the example carries no dead variables the code never reads.
 *
 * When this fails, the fix is to update the example — not to loosen the test.
 */
const ROOT = resolve(__dirname, "../..");
const EXAMPLE = readFileSync(join(ROOT, ".env.production.example"), "utf8");

/** Variables the runtime/framework supplies; never written into .env. */
const FRAMEWORK_VARS = new Set([
  "NODE_ENV",
  "NEXT_PHASE",
  "NEXT_RUNTIME",
  "CI",
  "SKIP_ENV_VALIDATION", // documented in the example, but commented out on purpose
]);

/** Set by docker-compose.prod.yml for a service, not by the operator. */
const COMPOSE_ONLY = new Set<string>([]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if ([".ts", ".tsx", ".mjs", ".js"].includes(extname(name))) out.push(full);
  }
  return out;
}

/** Every `process.env.X` / `process.env["X"]` the shipped code reads. */
function varsReadByCode(): Map<string, string> {
  const pattern =
    /process\.env(?:\.([A-Za-z_][A-Za-z_0-9]*)|\[\s*["'`]([A-Za-z_][A-Za-z_0-9]*)["'`]\s*\])/g;
  const found = new Map<string, string>();
  const files = [
    ...sourceFiles(join(ROOT, "src")),
    ...sourceFiles(join(ROOT, "scripts")),
    join(ROOT, "prisma/seed.ts"),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(pattern)) {
      const name = m[1] ?? m[2];
      if (!found.has(name)) found.set(name, file.slice(ROOT.length + 1));
    }
  }
  // Names declared in the zod schema are read through the parsed object rather
  // than a literal `process.env.X`, so pick those up from the schema too.
  const envSrc = readFileSync(join(ROOT, "src/lib/env.ts"), "utf8");
  for (const m of envSrc.matchAll(/^ {6}([A-Z][A-Z_0-9]+):/gm)) {
    if (!found.has(m[1])) found.set(m[1], "src/lib/env.ts (zod schema)");
  }
  // The third indirection: every integration credential is read as
  // `process.env[field.envVar]` in modules/integrations/resolve.ts, so the name
  // only ever appears as a string in the registry. Without this, adding a
  // provider to Settings makes its documented variables look dead.
  const registrySrc = readFileSync(join(ROOT, "src/modules/integrations/registry.ts"), "utf8");
  for (const m of registrySrc.matchAll(/envVar:\s*"([A-Z][A-Z_0-9]*)"/g)) {
    if (!found.has(m[1])) found.set(m[1], "src/modules/integrations/registry.ts (envVar)");
  }
  return found;
}

/** Assignments in the example, including intentionally commented-out ones. */
function varsInExample(): { active: Set<string>; commented: Set<string> } {
  const active = new Set<string>();
  const commented = new Set<string>();
  for (const line of EXAMPLE.split("\n")) {
    const t = line.trim();
    const bare = t.match(/^([A-Z][A-Z_0-9]*)=/);
    if (bare) {
      active.add(bare[1]);
      continue;
    }
    const off = t.match(/^#\s*([A-Z][A-Z_0-9]*)=/);
    if (off) commented.add(off[1]);
  }
  return { active, commented };
}

describe(".env.production.example completeness", () => {
  const read = varsReadByCode();
  const { active, commented } = varsInExample();
  const documented = new Set([...active, ...commented]);

  it("documents every variable the code reads", () => {
    const missing = [...read.keys()]
      .filter((v) => !FRAMEWORK_VARS.has(v) || commented.has(v))
      .filter((v) => !documented.has(v))
      .map((v) => `${v} (read in ${read.get(v)})`);
    expect(missing).toEqual([]);
  });

  it("carries no dead variables", () => {
    // Consumed by docker-compose.prod.yml / Caddyfile.prod / scripts/backup.sh
    // rather than by application code.
    const infra = new Set([
      "APP_HOST",
      "WWW_HOST",
      "PUBLIC_AUDIT_HOST",
      "PUBLIC_QUOTE_HOST",
      "PUBLIC_MEET_HOST",
      "ACME_EMAIL",
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "POSTGRES_DB",
      "BACKUP_DIR",
      "RETENTION_DAYS",
      // Read by Next.js itself at build and run time, and handed to the image
      // build as a BuildKit secret by docker-compose.prod.yml.
      "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
    ]);
    const dead = [...active].filter(
      (v) => !read.has(v) && !infra.has(v) && !COMPOSE_ONLY.has(v),
    );
    expect(dead).toEqual([]);
  });

  it("references every infra variable it declares", () => {
    const compose = readFileSync(join(ROOT, "docker-compose.prod.yml"), "utf8");
    const caddy = readFileSync(join(ROOT, "Caddyfile.prod"), "utf8");
    const backup = readFileSync(join(ROOT, "scripts/backup.sh"), "utf8");
    const infra = [
      "APP_HOST",
      "WWW_HOST",
      "PUBLIC_AUDIT_HOST",
      "PUBLIC_QUOTE_HOST",
      "PUBLIC_MEET_HOST",
      "ACME_EMAIL",
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "POSTGRES_DB",
      /**
       * APP_DB_PASSWORD is deliberately NOT here any more.
       *
       * It used to be interpolated into the app service's DATABASE_URL. That
       * line is the owner's connection now (see the comment in
       * docker-compose.prod.yml), and the variable is read by the application
       * instead — src/lib/rls.ts builds the app_user connection from it when
       * DB_RLS is on. The sibling test above, which scans src for
       * `process.env.X`, is what covers it.
       */
      "BACKUP_DIR",
      "RETENTION_DAYS",
    ];
    const unused = infra.filter(
      (v) => !compose.includes(v) && !caddy.includes(v) && !backup.includes(v),
    );
    expect(unused).toEqual([]);
  });
});

describe(".env.production.example correctness", () => {
  /** Parse the example the way docker-compose/dotenv would. */
  function parseExample(): NodeJS.ProcessEnv {
    const env: Record<string, string> = { NODE_ENV: "production" };
    for (const line of EXAMPLE.split("\n")) {
      const m = line.trim().match(/^([A-Z][A-Z_0-9]*)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
    return env as NodeJS.ProcessEnv;
  }

  const env = parseExample();

  it("matches the CLAUDE.md domain layout", () => {
    expect(env.APP_URL).toBe("https://ventureco.agency");
    expect(env.PUBLIC_AUDIT_URL).toBe("https://audit.ventureco.agency");
    expect(env.PUBLIC_QUOTE_URL).toBe("https://quote.ventureco.agency");
    expect(env.PUBLIC_MEET_URL).toBe("https://meet.ventureco.agency");
    expect(env.APP_HOST).toBe("ventureco.agency");
    expect(env.WWW_HOST).toBe("www.ventureco.agency");
    expect(env.NEXTAUTH_URL).toBe(env.APP_URL);
    // The three Caddy hostnames must be the host parts of the three URLs.
    for (const [urlVar, hostVar] of [
      ["PUBLIC_AUDIT_URL", "PUBLIC_AUDIT_HOST"],
      ["PUBLIC_QUOTE_URL", "PUBLIC_QUOTE_HOST"],
      ["PUBLIC_MEET_URL", "PUBLIC_MEET_HOST"],
    ] as const) {
      expect(new URL(env[urlVar] as string).hostname).toBe(env[hostVar]);
    }
  });

  it("ships two distinct Mailgun configurations in the EU region", () => {
    expect(env.MAILGUN_DOMAIN).toBe("mg.ventureco.group");
    expect(env.MAILGUN_COLD_DOMAIN).toBe("cold.ventureco.agency");
    expect(env.MAILGUN_DOMAIN).not.toBe(env.MAILGUN_COLD_DOMAIN);
    expect(env.MAILGUN_API_KEY).not.toBe(env.MAILGUN_COLD_API_KEY);
    expect(env.MAILGUN_EU).toBe("true");
    expect(env.MAIL_PROVIDER).toBe("mailgun");
  });

  it("selects postgres", () => {
    expect(env.DB_FLAVOR).toBe("postgres");
    expect(env.DATABASE_URL).toMatch(/^postgresql:\/\//);
    // The app connects as the non-superuser RLS role, not the superuser.
    expect(env.DATABASE_URL).toContain("app_user");
    expect(env.DATABASE_URL).not.toContain(`//${env.POSTGRES_USER}:`);
  });

  it("uses placeholders for every secret — never a real value", () => {
    const secrets = [
      "POSTGRES_PASSWORD",
      "APP_DB_PASSWORD",
      "NEXTAUTH_SECRET",
      "ANTHROPIC_API_KEY",
      "MAILGUN_API_KEY",
      "MAILGUN_COLD_API_KEY",
      "MAILGUN_WEBHOOK_SIGNING_KEY",
      "GOOGLE_PLACES_API_KEY",
      "PAGESPEED_API_KEY",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ];
    for (const key of secrets) {
      expect(env[key], `${key} must be present`).toBeDefined();
      expect(env[key], `${key} must be an obvious placeholder`).toMatch(/CHANGE-ME/);
    }
  });

  it("would fail the boot check while still holding placeholders", () => {
    // Proof the gate actually bites: the shipped example is not a valid config.
    const result = validateEnv(env, true);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.variable)).toContain("NEXTAUTH_SECRET");
  });

  it("passes the boot check once the placeholders are replaced", () => {
    const filled: NodeJS.ProcessEnv = { ...env };
    const real: Record<string, string> = {
      POSTGRES_PASSWORD: "8f2b0c9d7e5a1436",
      APP_DB_PASSWORD: "1c4e7a90bd35f682",
      NEXTAUTH_SECRET: "3Qk9vZ1xR7pL0sN4tB6mY8wC2hJ5dF7gA1eK3uT9oI0=",
      ANTHROPIC_API_KEY: "sk-ant-api03-realish-key",
      MAILGUN_API_KEY: "key-transactional-real",
      MAILGUN_COLD_API_KEY: "key-cold-real",
      MAILGUN_WEBHOOK_SIGNING_KEY: "whsk-real",
      GOOGLE_PLACES_API_KEY: "AIza-real",
      PAGESPEED_API_KEY: "AIza-real-psi",
      GOOGLE_CLIENT_ID: "1234.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "gocspx-real",
    };
    Object.assign(filled, real);
    filled.DATABASE_URL = `postgresql://app_user:${real.APP_DB_PASSWORD}@db:5432/ventureos?schema=public`;

    const result = validateEnv(filled, true);
    expect(result.problems).toEqual([]);
  });

  it("explains every variable with a comment above it", () => {
    const lines = EXAMPLE.split("\n");
    const unexplained: string[] = [];
    lines.forEach((line, i) => {
      if (!/^[A-Z][A-Z_0-9]*=/.test(line.trim())) return;
      // Walk back over any sibling assignments to the nearest comment line.
      let j = i - 1;
      while (j >= 0 && /^[A-Z][A-Z_0-9]*=/.test(lines[j].trim())) j -= 1;
      const prose = lines[j]?.trim() ?? "";
      const isProse = prose.startsWith("#") && !/^#\s*=+$/.test(prose);
      if (!isProse) unexplained.push(line.split("=")[0]);
    });
    expect(unexplained).toEqual([]);
  });
});
