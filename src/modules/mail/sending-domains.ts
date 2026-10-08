import { prismaUnsafe } from "@/lib/db";
import { coldMailDomain, transactionalMailDomain } from "@/lib/env";
import { parseColdConfig } from "@/modules/campaigns/logic";
import { parseOutboundConfig } from "@/modules/outbound/config";
import { registrableDomain, domainOfAddress, type SendingPolicy } from "./sending-policy";

/**
 * Load a workspace's sending policy (see ./sending-policy.ts).
 *
 * Reads every live workspace, because "no workspace may send through another
 * workspace's domain" needs to know what the others configured. Workspace rows
 * are a global table and a handful of them; this runs at send and save time,
 * never on a page load.
 */

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
}

/** The domains a workspace has EXPLICITLY configured — its claims. */
function claimsOf(ws: { mailgunConfig: unknown; featureFlags: unknown; outboundConfig: unknown }): {
  transactional: string | null;
  cold: string | null;
  outboundAddress: string | null;
} {
  const mail = obj(ws.mailgunConfig);
  return {
    transactional: str(mail.domain),
    cold: str(parseColdConfig(ws.featureFlags).coldDomain) ?? str(mail.coldDomain),
    outboundAddress: str(parseOutboundConfig(ws.outboundConfig).sending.senderAddress),
  };
}

export async function loadSendingPolicy(workspaceId: string): Promise<SendingPolicy> {
  const all = await prismaUnsafe.workspace.findMany({
    where: { deletedAt: null },
    select: { id: true, createdAt: true, mailgunConfig: true, featureFlags: true, outboundConfig: true },
    orderBy: { createdAt: "asc" },
  });
  const mine = all.find((w) => w.id === workspaceId);
  const own = mine ? claimsOf(mine) : { transactional: null, cold: null, outboundAddress: null };

  /**
   * Who owns each registrable domain: the FIRST workspace (by creation) that
   * configured it. A later workspace naming the same domain does not share
   * it — it is refused, at save and at send. Without an owner rule two
   * workspaces claiming one domain would each be allowed to use it, which is
   * exactly the crossing this guard exists to stop.
   */
  const owner = new Map<string, string>();
  for (const w of all) {
    const c = claimsOf(w);
    for (const d of [c.transactional, c.cold, c.outboundAddress ? domainOfAddress(c.outboundAddress) : null]) {
      const r = registrableDomain(d);
      if (r && !owner.has(r)) owner.set(r, w.id);
    }
  }
  const foreignDomains = new Set<string>();
  for (const [domain, ownerId] of owner) {
    if (ownerId !== workspaceId) foreignDomains.add(domain);
  }

  return {
    workspaceId,
    outboundAddress: own.outboundAddress,
    // The installation's domains are the defaults every workspace inherits
    // until it configures its own; they are nobody's claim.
    transactionalDomain: own.transactional ?? transactionalMailDomain()?.toLowerCase() ?? null,
    coldDomain: own.cold ?? coldMailDomain()?.toLowerCase() ?? null,
    foreignDomains,
  };
}
