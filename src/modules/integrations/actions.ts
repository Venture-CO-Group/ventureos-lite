"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireOwner } from "@/lib/authz";
import { encryptSecret, maskSecret, CredentialCryptoError } from "@/lib/crypto";
import {
  INFRASTRUCTURE_VARS,
  INTEGRATION_GROUPS,
  fieldByKey,
  isKnownField,
  validateField,
  validateResolved,
} from "./registry";
import { resolveIntegrations, resolveNavCredentials } from "./resolve";
import { brandFrom } from "@/modules/workspaces/brand";
import { navQueryTaxpayer } from "@/modules/registry/nav-taxpayer";

/**
 * Settings → Integrations. Owner-only, audit-logged, and the values never
 * leave the server in readable form — the UI receives masks.
 */

export interface IntegrationFieldView {
  key: string;
  label: string;
  kind: "secret" | "plain";
  help?: string;
  placeholder?: string;
  /** Masked for secrets, clear for plain values. Empty when unset. */
  display: string;
  configured: boolean;
  /** "db" when this workspace overrides it, "env" when inherited, null if unset. */
  source: "db" | "env" | null;
  envVar: string;
}

export interface IntegrationGroupView {
  id: string;
  title: string;
  description: string;
  testable: boolean;
  fields: IntegrationFieldView[];
}

export interface IntegrationsView {
  groups: IntegrationGroupView[];
  infrastructure: Array<{ name: string; note: string; present: boolean }>;
  problems: Array<{ key: string; message: string }>;
  /** True when CREDENTIALS_KEY is missing — nothing can be saved without it. */
  encryptionUnavailable: boolean;
}

export async function getIntegrations(): Promise<IntegrationsView> {
  await requireOwner();
  const { workspaceId } = await getActiveContext();
  const { values, fromDb, problems } = await resolveIntegrations(workspaceId);

  const groups: IntegrationGroupView[] = INTEGRATION_GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    testable: g.testable,
    fields: g.fields.map((f) => {
      const value = values[f.key] ?? null;
      return {
        key: f.key,
        label: f.label,
        kind: f.kind,
        help: f.help,
        placeholder: f.placeholder,
        // A secret is NEVER sent to the browser, only its last four characters.
        display: value ? (f.kind === "secret" ? maskSecret(value) : value) : "",
        configured: !!value,
        source: value ? (fromDb.has(f.key) ? "db" : "env") : null,
        envVar: f.envVar,
      };
    }),
  }));

  return {
    groups,
    infrastructure: INFRASTRUCTURE_VARS.map((v) => ({
      ...v,
      // Presence only — never the value.
      present: !!process.env[v.name]?.trim(),
    })),
    problems,
    encryptionUnavailable: !process.env.CREDENTIALS_KEY?.trim(),
  };
}

const saveSchema = z.object({
  key: z.string().min(1),
  /** Empty string clears the override and falls back to env. */
  value: z.string().max(2000),
});

export async function saveIntegration(
  raw: unknown,
): Promise<{ ok: true; display: string } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can change integrations." };
  }
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success || !isKnownField(parsed.data.key)) {
    return { ok: false, error: "Unknown setting." };
  }
  const field = fieldByKey(parsed.data.key)!;
  const value = parsed.data.value.trim();

  const shape = validateField(field.key, value);
  if (shape) return { ok: false, error: shape };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  // Check the invariant against what the resolved set would become, not just
  // the value in isolation — saving a cold domain equal to the transactional
  // one must be refused even though the value itself is a valid hostname.
  const { values } = await resolveIntegrations(workspaceId);
  const next = { ...values, [field.key]: value || null };
  const problems = validateResolved(next);
  const blocking = problems.find((p) => p.key === field.key);
  if (blocking) return { ok: false, error: blocking.message };

  if (!value) {
    await db.integration.deleteMany({ where: { key: field.key } });
    await audit(workspaceId, userId, "integration.cleared", field.key);
    revalidatePath("/settings");
    return { ok: true, display: "" };
  }

  let valueEnc: string | null = null;
  let valuePlain: string | null = null;
  if (field.kind === "secret") {
    try {
      valueEnc = encryptSecret(value);
    } catch (e) {
      if (e instanceof CredentialCryptoError) {
        return {
          ok: false,
          error: "CREDENTIALS_KEY is not set on the server, so secrets cannot be stored.",
        };
      }
      throw e;
    }
  } else {
    valuePlain = value;
  }

  await db.integration.upsert({
    where: { workspaceId_key: { workspaceId, key: field.key } },
    update: { valueEnc, valuePlain, updatedBy: userId },
    create: { workspaceId, key: field.key, valueEnc, valuePlain, updatedBy: userId },
  });

  await audit(workspaceId, userId, "integration.updated", field.key);
  revalidatePath("/settings");
  return { ok: true, display: field.kind === "secret" ? maskSecret(value) : value };
}

async function audit(
  workspaceId: string,
  actorUserId: string,
  action: string,
  key: string,
): Promise<void> {
  // audit_logs is a tenant table — write it through the guarded client so the
  // workspace scope is enforced rather than merely supplied (hard rule #1).
  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId,
      action,
      entityType: "Integration",
      entityId: key,
      // The KEY is logged, never the value.
      meta: { field: key },
    },
  });
}

// ---------------------------------------------------------------------------
// connection tests
// ---------------------------------------------------------------------------

export interface TestResult {
  ok: boolean;
  message: string;
}

/**
 * Prove a credential actually works, using the cheapest authenticated call each
 * provider offers. Never mutates anything at the provider.
 */
export async function testIntegration(raw: unknown): Promise<TestResult> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, message: "Only an Owner can test integrations." };
  }
  const parsed = z.object({ groupId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Unknown integration." };

  const { workspaceId } = await getActiveContext();
  const { values } = await resolveIntegrations(workspaceId);

  try {
    switch (parsed.data.groupId) {
      case "anthropic":
        return await testAnthropic(values["anthropic.apiKey"]);
      case "google":
        return await testGoogle(values["google.placesApiKey"], values["google.pagespeedApiKey"]);
      case "mailgun_transactional":
        return await testMailgun(values["mailgun.tx.domain"], values["mailgun.tx.apiKey"], "transactional");
      case "mailgun_cold":
        return await testMailgun(values["mailgun.cold.domain"], values["mailgun.cold.apiKey"], "cold");
      case "nav":
        return await testNav(workspaceId);
      case "cegadat":
        return await testCegadat(values["cegadat.apiKey"]);
      default:
        return { ok: false, message: "That integration has no connection test." };
    }
  } catch (e) {
    return { ok: false, message: `Could not reach the provider: ${(e as Error).message}` };
  }
}

/**
 * The search endpoint is unlimited on every plan, so a test costs nothing
 * against the monthly detail quota. A detail call would spend a unit to prove
 * the same thing.
 */
async function testCegadat(apiKey: string | null): Promise<TestResult> {
  if (!apiKey) return { ok: false, message: "No API key configured." };
  const { CegadatProvider, RegistryAuthError } = await import("@/modules/registry/cegadat");
  try {
    const page = await new CegadatProvider(apiKey).search({ name: "WellData", limit: 1 });
    return { ok: true, message: `Key accepted (search returned ${page.totalResults} result${page.totalResults === 1 ? "" : "s"}).` };
  } catch (e) {
    if (e instanceof RegistryAuthError) return { ok: false, message: "Cégadat rejected that key or the subscription is not active." };
    throw e;
  }
}

async function testAnthropic(apiKey: string | null): Promise<TestResult> {
  if (!apiKey) return { ok: false, message: "No API key configured." };
  // /v1/models is authenticated and free — it costs nothing against the budget.
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (res.ok) return { ok: true, message: "Key accepted." };
  if (res.status === 401) return { ok: false, message: "Anthropic rejected that key." };
  return { ok: false, message: `Anthropic returned ${res.status}.` };
}

async function testGoogle(places: string | null, psi: string | null): Promise<TestResult> {
  if (!places && !psi) return { ok: false, message: "No Google keys configured." };
  const notes: string[] = [];

  if (places) {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": places,
        "X-Goog-FieldMask": "places.id",
      },
      body: JSON.stringify({ textQuery: "kávézó Budapest", pageSize: 1 }),
    });
    notes.push(res.ok ? "Places: ok" : `Places: ${res.status}`);
  }
  if (psi) {
    const res = await fetch(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https%3A%2F%2Fexample.com&key=${encodeURIComponent(psi)}`,
    );
    notes.push(res.ok ? "PageSpeed: ok" : `PageSpeed: ${res.status}`);
  }
  const allOk = notes.every((n) => n.endsWith("ok"));
  return { ok: allOk, message: notes.join(" · ") };
}

async function testMailgun(
  domain: string | null,
  apiKey: string | null,
  which: "transactional" | "cold",
): Promise<TestResult> {
  if (!domain || !apiKey) {
    return { ok: false, message: `No ${which} domain or key configured.` };
  }
  const base =
    process.env.MAILGUN_EU === "true" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
  const res = await fetch(`${base}/v3/domains/${encodeURIComponent(domain)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}` },
  });
  if (res.ok) {
    const data = (await res.json()) as { domain?: { state?: string } };
    const state = data.domain?.state ?? "unknown";
    return {
      ok: state === "active",
      message:
        state === "active"
          ? `${domain} is active.`
          : `${domain} exists but its state is "${state}" — finish DNS verification.`,
    };
  }
  if (res.status === 401) return { ok: false, message: "Mailgun rejected that key." };
  if (res.status === 404) return { ok: false, message: `Mailgun does not know ${domain}.` };
  return { ok: false, message: `Mailgun returned ${res.status}.` };
}

/**
 * Prove the NAV credentials by looking up the workspace's OWN tax number.
 *
 * queryTaxpayer is read-only and changes nothing, and querying yourself is the
 * cheapest possible proof: a signature failure, a wrong technical user or a
 * mismatched taxpayer relation all surface distinctly, and a success comes back
 * with the operator's own legal name — which is a far more convincing "it
 * works" than a bare OK.
 */
async function testNav(workspaceId: string): Promise<TestResult> {
  const brand = brandFrom(
    (await prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { brand: true },
    }))?.brand,
  );
  const creds = await resolveNavCredentials(workspaceId, brand);
  if (!creds) {
    return {
      ok: false,
      message:
        "Hiányzó adat. A lekérdezéshez kell: technikai felhasználó, jelszó, aláírókulcs, saját adószám és szoftver azonosító.",
    };
  }

  const lookup = await navQueryTaxpayer(creds.taxNumber, creds, {
    // Free, but counted: NAV publishes no numeric rate limit, so volume is the
    // only early warning we get. Cost is exactly 0 and that is the honest value.
    logUsage: async ({ operation, outcome }) => {
      await getWorkspaceClient(workspaceId).apiUsage.create({
        data: { workspaceId, provider: "nav", operation: `${operation}:${outcome}`, cost: 0 },
      });
    },
  });
  switch (lookup.status) {
    case "valid":
      return {
        ok: true,
        message: `Kapcsolat rendben (${creds.environment}). A NAV szerint: ${lookup.taxpayer.legalName}.`,
      };
    case "deregistered":
      // The credentials work; the news is about the taxpayer, not the link.
      return {
        ok: true,
        message: `Kapcsolat rendben, de a NAV szerint ez az adószám megszűnt: ${lookup.taxpayer.legalName}.`,
      };
    case "unknown":
      return {
        ok: false,
        message: "A kapcsolat él, de a NAV nem ismeri a megadott saját adószámot.",
      };
    case "error":
      return { ok: false, message: lookup.message };
  }
}
