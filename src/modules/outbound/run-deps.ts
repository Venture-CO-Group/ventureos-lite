/**
 * The production wiring of a sourcing run's dependencies (playbook-v6 F3).
 * Kept apart from the engine so tests inject their own and never touch the
 * network, the audit queue or a mailbox.
 */
import { readSite } from "@/modules/leads/enrichment";
import { verifyAddress } from "@/modules/verification/verify";
import { getVerifier } from "@/modules/verification/provider";
import { startOrReuseAudit } from "./audit-bridge";
import type { RunDeps } from "./run-engine";

export async function productionRunDeps(workspaceId: string, extra: Partial<RunDeps> = {}): Promise<RunDeps> {
  const provider = await getVerifier(workspaceId);
  return {
    now: () => new Date(),
    startAudit: (ws, url) => startOrReuseAudit(ws, url),
    readSite: async (url) => {
      const r = await readSite(url);
      return { emails: r.contacts.emails, phones: r.contacts.phones, names: r.contacts.names ?? [] };
    },
    verify: (email) => verifyAddress(email, { provider }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...extra,
  };
}
