import { prismaUnsafe } from "@/lib/db";
import { appUrl, auditUrl } from "@/lib/env";

/**
 * Which workspace receives public inbound (P12/1a).
 *
 * Every other public surface resolves its tenant from a slug — a booking page
 * or a share link belongs to a workspace. The self-serve audit landing has no
 * slug, so the tenant has to come from configuration.
 *
 * Fails CLOSED. Guessing which tenant gets an inbound lead would be a tenancy
 * violation (hard rule #1), so with several workspaces and no explicit setting
 * we refuse rather than pick one.
 */
export class PublicIntakeUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicIntakeUnavailable";
  }
}

export async function getPublicIntakeWorkspaceId(): Promise<string> {
  const configured = process.env.PUBLIC_INTAKE_WORKSPACE_ID?.trim();
  if (configured) {
    const ws = await prismaUnsafe.workspace.findUnique({
      where: { id: configured },
      select: { id: true },
    });
    if (!ws) {
      throw new PublicIntakeUnavailable(
        `PUBLIC_INTAKE_WORKSPACE_ID is set to "${configured}" but no such workspace exists.`,
      );
    }
    return ws.id;
  }

  const all = await prismaUnsafe.workspace.findMany({ where: { deletedAt: null }, select: { id: true }, take: 2 });
  if (all.length === 1) return all[0]!.id;
  if (all.length === 0) {
    throw new PublicIntakeUnavailable("No workspace exists to receive public audits.");
  }
  throw new PublicIntakeUnavailable(
    "Several workspaces exist; set PUBLIC_INTAKE_WORKSPACE_ID to say which one receives public inbound.",
  );
}

/**
 * Domains that belong to us. Derived from the configured hosts rather than
 * hardcoded, so a different deployment does not audit itself (CLAUDE.md:
 * every host comes from the environment).
 */
export function ownDomains(): string[] {
  const hosts: string[] = [];
  for (const url of [appUrl(), auditUrl()]) {
    try {
      hosts.push(new URL(url).hostname.replace(/^www\./, "").toLowerCase());
    } catch {
      /* a malformed env value is caught by the boot gate, not here */
    }
  }
  // audit.ventureco.agency and ventureco.agency share a registrable domain;
  // keep both plus their parent so subdomain matching covers all of them.
  const parents = hosts
    .map((h) => h.split(".").slice(-2).join("."))
    .filter((h) => h.includes("."));
  return [...new Set([...hosts, ...parents])];
}

/**
 * Domains of companies we already work with. They get a warm "ügyfelünk vagy"
 * message instead of being funnelled as a prospect.
 *
 * "Client" = has a won deal, or has been issued a contract or completion
 * certificate. Both are unambiguous signals of an existing relationship, and
 * both are already recorded.
 */
export async function clientDomains(workspaceId: string): Promise<string[]> {
  const companies = await prismaUnsafe.company.findMany({
    where: {
      workspaceId,
      OR: [
        { leads: { some: { outcomes: { some: { result: "WON" } } } } },
        {
          leads: {
            some: { documents: { some: { type: { in: ["CONTRACT", "CERTIFICATE"] } } } },
          },
        },
      ],
    },
    select: { domain: true, website: true },
  });

  const out = new Set<string>();
  for (const c of companies) {
    const raw = c.domain ?? c.website;
    if (!raw) continue;
    try {
      const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
      out.add(host.replace(/^www\./, "").toLowerCase());
    } catch {
      out.add(raw.replace(/^www\./, "").toLowerCase());
    }
  }
  return [...out];
}
