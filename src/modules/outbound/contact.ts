/**
 * The contact-resolution waterfall (spec §4.43.6, playbook-v6 F3/7).
 *
 * In order, first usable hit wins, and every step records where its data came
 * from:
 *
 *   1. registry   — a personal address on the datasheet, for a named manager;
 *   2. impresszum — a personal address on the company's own site;
 *   3. crm        — an existing lead with an address at the same company;
 *   4. named + generic — a manager's name we know, written to the general
 *      mailbox: the greeting is personal, the recipient is info@;
 *   5. generic    — an address only: the draft asks to be forwarded;
 *   6. none       — the LinkedIn queue, with the manager's name to search for.
 *
 * Each address is verified before it is accepted; an invalid one falls
 * through to the next step rather than failing the candidate. Pure apart from
 * the injected verifier.
 */
import type { VerifyResult } from "@/modules/verification/types";
import { normalizeEmail } from "@/modules/capture/contact";

export type ContactKind = "named" | "named_generic" | "generic" | "none";
export type ContactSource = "registry" | "impresszum" | "crm" | "registry+generic" | "site+generic";

export interface ResolvedContact {
  kind: ContactKind;
  name: string | null;
  email: string | null;
  phone: string | null;
  source: ContactSource | null;
  /** A manager name we know, kept even when it could not be paired with an address. */
  managerName: string | null;
  verify: { status: VerifyResult["status"]; reason: string } | null;
  /** What each step found and why it was or was not used — shown to the reviewer. */
  trail: string[];
}

export interface WaterfallInput {
  registry: { email: string | null; phone: string | null; managers: string[] } | null;
  site: { emails: string[]; phones: string[]; representedBy: string[] } | null;
  crm: Array<{ name: string | null; email: string; phone: string | null }>;
}

/** Role addresses: what a business uses for its shared inbox. */
const ROLE = /^(info|iroda|office|hello|hi|kapcsolat|contact|recepcio|reception|ugyfelszolgalat|support|sales|ertekesites|admin|titkarsag|mail|posta|rendeles|bejelentkezes|foglalas|booking|marketing)$/i;

export function isRoleAddress(email: string): boolean {
  const local = (email.split("@")[0] ?? "").replace(/[0-9]+$/, "");
  return ROLE.test(local);
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * Does a personal address plausibly belong to this person? "kovacs.anna@",
 * "akovacs@", "anna@" for Kovács Anna — a name part of four letters or more
 * appearing in the local part.
 */
export function addressMatchesName(email: string, name: string): boolean {
  const local = fold(email.split("@")[0] ?? "").replace(/[^a-z]/g, "");
  const parts = fold(name)
    .replace(/\bdr\.?\s*/g, "")
    .split(/[^a-z]+/)
    .filter((p) => p.length >= 4);
  return parts.some((p) => local.includes(p));
}

/** Strip honorifics a greeting will add back on its own. */
export function cleanPersonName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export async function resolveContact(
  input: WaterfallInput,
  verify: (email: string) => Promise<VerifyResult>,
): Promise<ResolvedContact> {
  const trail: string[] = [];
  const managers = [...(input.registry?.managers ?? []), ...(input.site?.representedBy ?? [])]
    .map(cleanPersonName)
    .filter((n, i, all) => n && all.indexOf(n) === i);
  const managerName = managers[0] ?? null;
  const phone = input.registry?.phone ?? input.site?.phones[0] ?? null;

  const checked = new Map<string, VerifyResult>();
  const usable = async (raw: string, label: string): Promise<VerifyResult | null> => {
    const email = normalizeEmail(raw).value;
    if (!email) {
      trail.push(`${label}: "${raw}" is not an address`);
      return null;
    }
    const res = checked.get(email) ?? (await verify(email));
    checked.set(email, res);
    if (res.status === "invalid") {
      trail.push(`${label}: ${email} is invalid (${res.reason}) — next step`);
      return null;
    }
    return res;
  };
  const result = (
    kind: ContactKind,
    source: ContactSource | null,
    name: string | null,
    v: VerifyResult | null,
  ): ResolvedContact => ({
    kind,
    name,
    email: v?.address ?? null,
    phone,
    source,
    managerName,
    verify: v ? { status: v.status, reason: v.reason } : null,
    trail,
  });

  const personalFor = (emails: string[]) =>
    emails
      .filter((e) => !isRoleAddress(e))
      .map((e) => ({ email: e, name: managers.find((m) => addressMatchesName(e, m)) ?? null }));

  // 1. Registry: a personal address that belongs to a named manager.
  const regEmail = input.registry?.email ?? null;
  if (regEmail) {
    const [p] = personalFor([regEmail]);
    if (p?.name) {
      const v = await usable(p.email, "registry");
      if (v) {
        trail.push(`registry: ${v.address} matches manager ${p.name}`);
        return result("named", "registry", p.name, v);
      }
    } else {
      trail.push(`registry: ${regEmail} is ${isRoleAddress(regEmail) ? "a shared inbox" : "not tied to a named manager"}`);
    }
  } else {
    trail.push("registry: no email on the datasheet");
  }

  // 2. Impresszum / contact page: a personal address for a named person.
  for (const p of personalFor(input.site?.emails ?? [])) {
    if (!p.name) continue;
    const v = await usable(p.email, "impresszum");
    if (v) {
      trail.push(`impresszum: ${v.address} matches ${p.name}`);
      return result("named", "impresszum", p.name, v);
    }
  }
  if (input.site) trail.push(`impresszum: ${input.site.emails.length} address(es), none personal for a known name`);
  else trail.push("impresszum: site not read");

  // 3. An existing CRM contact at the same company.
  for (const c of input.crm) {
    const v = await usable(c.email, "crm");
    if (v) {
      trail.push(`crm: existing contact ${c.name ?? v.address}`);
      return result(c.name ? "named" : "generic", "crm", c.name, v);
    }
  }
  if (input.crm.length === 0) trail.push("crm: no contact at this company");

  // 4–5. A generic address: personal greeting if we know a name.
  const generic = [regEmail, ...(input.site?.emails ?? [])].filter((e): e is string => !!e);
  for (const e of generic) {
    const v = await usable(e, "generic");
    if (!v) continue;
    const fromRegistry = e === regEmail;
    if (managerName) {
      trail.push(`named + generic: greeting ${managerName}, sent to ${v.address}`);
      return result("named_generic", fromRegistry ? "registry+generic" : "site+generic", managerName, v);
    }
    trail.push(`generic: ${v.address}, no name — the draft asks for forwarding`);
    return result("generic", fromRegistry ? "registry+generic" : "site+generic", null, v);
  }

  // 6. Nothing to write to.
  trail.push(managerName ? `none: LinkedIn queue, search for ${managerName}` : "none: LinkedIn queue");
  return result("none", null, null, null);
}

export { extractRepresentedBy } from "@/modules/leads/impresszum";
