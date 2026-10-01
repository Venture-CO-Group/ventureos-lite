import { normalizeEmail } from "../leads/dedupe";

/**
 * The shared suppression list (spec §4.16, §4.43.9). One list for every
 * channel — cold campaigns, outbound, replies from the Inbox — holding three
 * kinds of entry:
 *
 *   - an address:            "anna@ceg.hu"   — that person;
 *   - a whole domain:        "@ceg.hu"       — everyone at the company. An
 *     outbound unsubscribe writes this, because "stop writing to us" from one
 *     person at a small firm means the firm (playbook-v6 F5/3);
 *   - a tax number:          "tax:12345678242" — the company itself, so a
 *     harvest that finds it again under a new domain still skips it.
 *
 * Older callers pass address lists and keep working: an address entry
 * matches exactly as before, and the new kinds only ever add refusals.
 */
export function isRecipientSuppressed(address: string, suppressed: string[]): boolean {
  const a = normalizeEmail(address);
  if (!a) return false;
  const domain = a.split("@")[1] ?? "";
  return suppressed.some((s) => {
    const entry = (s ?? "").trim().toLowerCase();
    if (entry.startsWith("@")) return domain.length > 0 && entry === `@${domain}`;
    return normalizeEmail(entry) === a;
  });
}

export function domainSuppressionEntry(domain: string): string {
  return `@${domain.replace(/^@/, "").replace(/^www\./, "").toLowerCase()}`;
}

export function taxSuppressionEntry(taxDigits: string): string {
  return `tax:${taxDigits.replace(/\D/g, "")}`;
}

/** Is this company — by domain, tax number or any of its addresses — off limits? */
export function isCompanySuppressed(
  company: { domain?: string | null; taxNumber?: string | null; emails?: string[] },
  suppressed: string[],
): boolean {
  const entries = new Set(suppressed.map((s) => (s ?? "").trim().toLowerCase()));
  if (company.domain && entries.has(domainSuppressionEntry(company.domain))) return true;
  if (company.taxNumber && entries.has(taxSuppressionEntry(company.taxNumber))) return true;
  return (company.emails ?? []).some((e) => isRecipientSuppressed(e, suppressed));
}
