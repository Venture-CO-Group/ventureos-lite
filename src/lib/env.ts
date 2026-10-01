/**
 * Boot-time environment validation + the single source of truth for every host
 * the app talks about.
 *
 * Two jobs:
 *  1. `assertEnv()` runs once at server boot (app via src/instrumentation.ts,
 *     worker via src/worker/index.ts) and refuses to start on a missing or
 *     malformed variable, printing exactly which ones are wrong.
 *  2. The `*Url()` / `*MailDomain()` helpers below are the ONLY place a host
 *     name is resolved. No module may hardcode a domain (CLAUDE.md → Domain
 *     layout): the app serves the root of ventureco.agency and the public
 *     surfaces live on audit./quote./meet. subdomains, all from env.
 *
 * Nothing here runs on import — importing this module is always side-effect
 * free so it is safe from route modules, tests and the edge runtime.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/** A bare hostname: no scheme, no port, no path. `mg.ventureco.group`. */
const bareHost = z
  .string()
  .trim()
  .min(1)
  .regex(
    /^(?=.{1,253}$)(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i,
    "must be a bare hostname with no scheme/port/path (e.g. mg.ventureco.group)",
  );

/** An absolute http(s) origin with no trailing slash: `https://ventureco.agency`. */
const originUrl = z
  .string()
  .trim()
  .min(1)
  .refine((v) => /^https?:\/\//i.test(v), "must start with http:// or https://")
  .refine((v) => !/\/$/.test(v), "must not end with a trailing slash")
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.pathname === "/" && !u.search && !u.hash;
    } catch {
      return false;
    }
  }, "must be a bare origin (scheme + host [+ port]) with no path");

const boolish = z.enum(["true", "false"]);

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

/**
 * `strict` = a production boot. Optional-in-dev variables become required and
 * the EU/region + domain-separation invariants are enforced.
 */
export function buildEnvSchema(strict: boolean) {
  const req = <T extends z.ZodTypeAny>(s: T) => (strict ? s : s.optional());

  return z
    .object({
      // ---- database ----------------------------------------------------
      DB_FLAVOR: z.enum(["postgres", "mysql"], {
        errorMap: () => ({ message: "must be exactly 'postgres' or 'mysql'" }),
      }),
      DATABASE_URL: z
        .string()
        .min(1)
        .refine(
          (v) => /^(postgresql|postgres|mysql):\/\//.test(v),
          "must be a postgresql:// or mysql:// connection string",
        ),
      // Password of the low-privilege role the Postgres RLS policies run as.
      APP_DB_PASSWORD: strict
        ? z.string().min(8, "must be at least 8 characters")
        : z.string().optional(),

      // ---- jobs / cache -------------------------------------------------
      REDIS_URL: z.string().min(1).refine((v) => /^rediss?:\/\//.test(v), "must start with redis://"),

      // ---- auth ----------------------------------------------------------
      NEXTAUTH_SECRET: z
        .string()
        .min(32, "must be at least 32 characters (openssl rand -base64 32)")
        .refine(
          (v) => !/^change-?me/i.test(v),
          "is still the placeholder — generate a real secret",
        ),
      NEXTAUTH_URL: originUrl,

      // ---- Anthropic -------------------------------------------------------
      ANTHROPIC_API_KEY: req(
        z.string().min(1).refine((v) => v.startsWith("sk-ant-"), "must start with 'sk-ant-'"),
      ),

      // ---- app + public surfaces ------------------------------------------
      APP_URL: originUrl,
      PUBLIC_AUDIT_URL: req(originUrl),
      PUBLIC_QUOTE_URL: req(originUrl),
      PUBLIC_MEET_URL: req(originUrl),
      FILES_DIR: z.string().min(1).refine((v) => v.startsWith("/"), "must be an absolute path"),

      // ---- credential encryption -------------------------------------------
      // Encrypts integration secrets at rest (src/lib/crypto.ts). Required in
      // production: without it, nothing can be saved in Settings → Integrations.
      CREDENTIALS_KEY: strict
        ? z.string().min(32, "must be at least 32 characters (openssl rand -base64 32)")
        : z.string().optional(),

      // ---- web push (playbook-v2 P6/1) --------------------------------------
      // Optional even in production: with no keys, push is simply unavailable
      // and the Settings toggle says so. Everything still lands in the bell.
      // Generate a pair with `npm run vapid`.
      VAPID_PUBLIC_KEY: z.string().min(1).optional(),
      VAPID_PRIVATE_KEY: z.string().min(1).optional(),
      /** mailto: the push service can reach if our sending misbehaves. */
      VAPID_SUBJECT: z
        .string()
        .refine((v) => /^mailto:.+@.+/.test(v), "must be a mailto: address")
        .optional(),

      // ---- mail ------------------------------------------------------------
      MAIL_PROVIDER: z.enum(["mailgun", "mock"]).optional(),
      MAILGUN_EU: strict
        ? z.literal("true", {
            errorMap: () => ({
              message: "must be 'true' — Venture data stays in the Mailgun EU region",
            }),
          })
        : boolish.optional(),
      MAILGUN_API_KEY: z.string().optional(),
      MAILGUN_DOMAIN: bareHost.optional(),
      MAILGUN_WEBHOOK_SIGNING_KEY: z.string().optional(),
      MAILGUN_COLD_API_KEY: z.string().optional(),
      MAILGUN_COLD_DOMAIN: bareHost.optional(),

      // ---- external providers ------------------------------------------------
      GOOGLE_PLACES_API_KEY: z.string().optional(),
      PAGESPEED_API_KEY: z.string().optional(),
      CALENDAR_PROVIDER: z.enum(["google", "mock"]).optional(),
      GOOGLE_CLIENT_ID: z.string().optional(),
      GOOGLE_CLIENT_SECRET: z.string().optional(),
      GOOGLE_REDIRECT_URI: z
        .string()
        .refine((v) => /^https?:\/\//.test(v), "must be an absolute http(s) URL")
        .optional(),
      // cegadat: the Cégadat API (playbook-v6 F2); `opten` stays accepted so an
      // older .env still boots, and resolves to "no provider" in production.
      REGISTRY_PROVIDER: z.enum(["cegadat", "mock", "opten"]).optional(),
      CEGADAT_API_KEY: z.string().optional(),
      SZAMLAZZ_PROVIDER: z.enum(["mock", "szamlazz"]).optional(),

      // ---- seed ----------------------------------------------------------------
      SEED_OWNER_EMAIL: z.string().email().optional(),
    })
    .superRefine((env, ctx) => {
      const issue = (path: string, message: string) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

      // --- hard rule: cold mail can never share the transactional domain ----
      const tx = env.MAILGUN_DOMAIN?.toLowerCase();
      const cold = env.MAILGUN_COLD_DOMAIN?.toLowerCase();
      if (tx && cold && tx === cold) {
        issue(
          "MAILGUN_COLD_DOMAIN",
          `must differ from MAILGUN_DOMAIN (both are "${tx}"). Cold outreach runs on its own ` +
            `sending domain so a cold-list complaint can never burn the transactional ` +
            `reputation. Use the cold.* domain here.`,
        );
      }

      // --- mailgun selected => transactional credentials complete -----------
      const usingMailgun =
        env.MAIL_PROVIDER === "mailgun" ||
        (env.MAIL_PROVIDER === undefined && !!env.MAILGUN_API_KEY);
      if (strict || usingMailgun) {
        if (!env.MAILGUN_API_KEY) {
          issue("MAILGUN_API_KEY", "is required when MAIL_PROVIDER=mailgun");
        }
        if (!env.MAILGUN_DOMAIN) {
          issue("MAILGUN_DOMAIN", "is required when MAIL_PROVIDER=mailgun");
        }
        if (!env.MAILGUN_WEBHOOK_SIGNING_KEY) {
          issue(
            "MAILGUN_WEBHOOK_SIGNING_KEY",
            "is required when MAIL_PROVIDER=mailgun — delivery/bounce webhooks are rejected without it",
          );
        }
      }

      // --- cold credentials are all-or-nothing ------------------------------
      if (env.MAILGUN_COLD_DOMAIN && !env.MAILGUN_COLD_API_KEY) {
        issue(
          "MAILGUN_COLD_API_KEY",
          "is required whenever MAILGUN_COLD_DOMAIN is set — the cold domain has its own Mailgun credentials",
        );
      }
      if (env.MAILGUN_COLD_API_KEY && !env.MAILGUN_COLD_DOMAIN) {
        issue("MAILGUN_COLD_DOMAIN", "is required whenever MAILGUN_COLD_API_KEY is set");
      }
      if (
        env.MAILGUN_COLD_API_KEY &&
        env.MAILGUN_API_KEY &&
        env.MAILGUN_COLD_API_KEY === env.MAILGUN_API_KEY
      ) {
        issue(
          "MAILGUN_COLD_API_KEY",
          "must be a distinct sending key from MAILGUN_API_KEY (separate domain, separate credentials)",
        );
      }

      // --- google calendar is all-or-nothing --------------------------------
      if (env.CALENDAR_PROVIDER === "google") {
        for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"] as const) {
          if (!env[k]) issue(k, "is required when CALENDAR_PROVIDER=google");
        }
      }
      // No CEGADAT_API_KEY requirement: the key may live in Settings →
      // Integrations instead, and without one the motor simply has no
      // registry — which it reports, rather than refusing to boot.

      // --- VAPID is all-or-nothing (P6/1) -----------------------------------
      // Half a key pair is worse than none: the browser would be handed a
      // public key, subscribe successfully, and then never receive anything.
      if (env.VAPID_PUBLIC_KEY && !env.VAPID_PRIVATE_KEY) {
        issue("VAPID_PRIVATE_KEY", "is required whenever VAPID_PUBLIC_KEY is set");
      }
      if (env.VAPID_PRIVATE_KEY && !env.VAPID_PUBLIC_KEY) {
        issue("VAPID_PUBLIC_KEY", "is required whenever VAPID_PRIVATE_KEY is set");
      }

      // --- the four surfaces must be four distinct origins -------------------
      const surfaces: Array<[string, string | undefined]> = [
        ["APP_URL", env.APP_URL],
        ["PUBLIC_AUDIT_URL", env.PUBLIC_AUDIT_URL],
        ["PUBLIC_QUOTE_URL", env.PUBLIC_QUOTE_URL],
        ["PUBLIC_MEET_URL", env.PUBLIC_MEET_URL],
      ];
      const seen = new Map<string, string>();
      for (const [name, value] of surfaces) {
        if (!value) continue;
        const prior = seen.get(value.toLowerCase());
        if (prior) {
          issue(name, `must be its own origin — it is identical to ${prior} ("${value}")`);
        } else {
          seen.set(value.toLowerCase(), name);
        }
      }

      // --- production must not point at loopback ------------------------------
      if (strict) {
        for (const [name, value] of [...surfaces, ["NEXTAUTH_URL", env.NEXTAUTH_URL] as const]) {
          if (!value) continue;
          if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(value)) {
            issue(name, `must be the public https origin, not a loopback address ("${value}")`);
          }
          if (!/^https:\/\//i.test(value)) {
            issue(name, `must use https in production ("${value}")`);
          }
        }
        if (env.DB_FLAVOR !== "postgres") {
          issue(
            "DB_FLAVOR",
            "must be 'postgres' for this deployment — the production stack ships Postgres 16 with row-level security",
          );
        }
      }
    });
}

export type Env = z.infer<ReturnType<typeof buildEnvSchema>>;

export interface EnvProblem {
  variable: string;
  message: string;
}

export interface EnvResult {
  ok: boolean;
  problems: EnvProblem[];
}

/** Validate without throwing. `strict` defaults to "are we in production". */
export function validateEnv(
  raw: NodeJS.ProcessEnv = process.env,
  strict = raw.NODE_ENV === "production",
): EnvResult {
  // Treat "" the same as unset — a blank line in .env should read as absent so
  // the "is required" message fires instead of a confusing format error.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.trim() !== "") cleaned[k] = v;
  }

  const parsed = buildEnvSchema(strict).safeParse(cleaned);
  if (parsed.success) return { ok: true, problems: [] };

  const problems = parsed.error.issues.map((i) => ({
    variable: String(i.path[0] ?? "(env)"),
    message:
      i.code === "invalid_type" && i.received === "undefined"
        ? "is required but not set"
        : i.message,
  }));
  // Stable, de-duplicated output — one line per problem, alphabetical.
  const unique = new Map<string, EnvProblem>();
  for (const p of problems) unique.set(`${p.variable} ${p.message}`, p);
  return {
    ok: false,
    problems: [...unique.values()].sort((a, b) => a.variable.localeCompare(b.variable)),
  };
}

/** Human-readable failure report — the exact text printed at a failed boot. */
export function formatEnvProblems(problems: EnvProblem[]): string {
  const lines = problems.map((p) => `  ✗ ${p.variable} — ${p.message}`);
  return [
    `Environment check failed — ${problems.length} problem${problems.length === 1 ? "" : "s"}:`,
    ...lines,
    "",
    "Fix these in .env (see .env.production.example) and restart.",
  ].join("\n");
}

/** Boot gate. Throws with the full list of problems; never partially reports. */
export function assertEnv(
  raw: NodeJS.ProcessEnv = process.env,
  strict = raw.NODE_ENV === "production",
): void {
  const result = validateEnv(raw, strict);
  if (!result.ok) throw new Error(formatEnvProblems(result.problems));
}

/**
 * What the app and the worker actually call at startup.
 *
 * Production: a bad configuration kills the process. Serving with quote links
 * pointing at localhost, or cold mail one typo away from the transactional
 * domain, is worse than not serving at all.
 *
 * Development: the same report is printed as a warning and the process
 * continues, so a half-filled .env does not block local work.
 */
export function checkEnvAtBoot(
  label: string,
  raw: NodeJS.ProcessEnv = process.env,
): EnvResult {
  const strict = raw.NODE_ENV === "production";
  const result = validateEnv(raw, strict);
  if (result.ok) return result;

  const report = formatEnvProblems(result.problems);
  if (strict) {
    // eslint-disable-next-line no-console
    console.error(`\n[${label}] ${report}\n`);
    throw new Error(report);
  }
  // eslint-disable-next-line no-console
  console.warn(`\n[${label}] (development — continuing anyway)\n${report}\n`);
  return result;
}

// ---------------------------------------------------------------------------
// host resolution — the only place a domain is decided
// ---------------------------------------------------------------------------

const DEV_APP_URL = "http://localhost:3000";

function trimSlash(v: string): string {
  return v.replace(/\/+$/, "");
}

/** Origin the authenticated app is served from (root of ventureco.agency). */
export function appUrl(): string {
  return trimSlash(process.env.APP_URL || DEV_APP_URL);
}

/**
 * Derive a public sub-surface origin. In production the explicit
 * `PUBLIC_*_URL` is required (validated above); in dev we derive
 * `<prefix>.<apphost>` so a developer needs no extra configuration.
 */
function publicSurface(explicit: string | undefined, prefix: string): string {
  if (explicit && explicit.trim()) return trimSlash(explicit.trim());
  const base = appUrl();
  try {
    const u = new URL(base);
    // localhost has no registrable parent — keep serving the path form in dev.
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname)) return base;
    u.hostname = `${prefix}.${u.hostname.replace(/^www\./i, "")}`;
    return trimSlash(u.toString());
  } catch {
    return base;
  }
}

/** Public audit-report surface — audit.ventureco.agency. */
export function auditUrl(): string {
  return publicSurface(process.env.PUBLIC_AUDIT_URL, "audit");
}

/** Public quote-acceptance surface — quote.ventureco.agency. */
export function quoteUrl(): string {
  return publicSurface(process.env.PUBLIC_QUOTE_URL, "quote");
}

/** Public booking surface — meet.ventureco.agency. */
export function meetUrl(): string {
  return publicSurface(process.env.PUBLIC_MEET_URL, "meet");
}

/** Verified transactional sending domain — mg.ventureco.group. */
export function transactionalMailDomain(): string | null {
  const v = process.env.MAILGUN_DOMAIN?.trim().toLowerCase();
  return v || null;
}

/** Verified cold-outreach sending domain — cold.ventureco.agency. */
export function coldMailDomain(): string | null {
  const v = process.env.MAILGUN_COLD_DOMAIN?.trim().toLowerCase();
  return v || null;
}
