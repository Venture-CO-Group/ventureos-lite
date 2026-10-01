/**
 * The facts a draft may cite (CLAUDE.md hard rule 10, spec §4.43.7).
 *
 * Built from stored data only — the audit's failed checks and flags, and the
 * registry datasheet — each with a stable id. The draft generator is handed
 * this list, and the hook gate refuses any draft whose personalisation points
 * do not reference ids from it. A candidate with no facts at all never gets
 * a draft.
 *
 * Pure, so what counts as "company-specific" is decided here, in one place,
 * and tested: a legal form is not a fact about THIS company in any useful
 * sense ("you are a Kft."), a founding year, a headcount or a slow homepage
 * are.
 */
import type { CompanyDatasheet } from "@/modules/registry/datasheet";
import { foundedYear } from "@/modules/registry/datasheet";
import { formatFt } from "./filter";

export type FactKind = "audit" | "registry" | "site";

export interface CandidateFact {
  id: string;
  kind: FactKind;
  label: string;
  value: string;
}

export interface AuditForFacts {
  score: number;
  flags: readonly string[];
  checks: ReadonlyArray<{ key: string; label: string; pass: boolean; detail?: string }>;
  url: string;
}

/** At most this many failed checks: the draft needs one, the reviewer reads them all. */
const MAX_AUDIT_FACTS = 8;

export function buildFacts(input: {
  sheet: CompanyDatasheet | null;
  audit: AuditForFacts | null;
  /** True when we looked and there is no website. */
  noWebsite: boolean;
  now?: Date;
}): CandidateFact[] {
  const facts: CandidateFact[] = [];
  const { sheet, audit } = input;

  if (audit) {
    for (const c of audit.checks.filter((c) => !c.pass).slice(0, MAX_AUDIT_FACTS)) {
      facts.push({ id: `audit:${c.key}`, kind: "audit", label: c.label, value: c.detail?.trim() || "fails" });
    }
    for (const f of audit.flags) {
      facts.push({ id: `flag:${f.replace(/\s+/g, "_")}`, kind: "audit", label: "Audit finding", value: f });
    }
  }
  if (input.noWebsite) {
    facts.push({ id: "site:none", kind: "site", label: "Website", value: "no website found (registry and search)" });
  }

  if (sheet) {
    const year = foundedYear(sheet);
    const now = input.now ?? new Date();
    if (year) {
      facts.push({ id: "registry:founded", kind: "registry", label: "Founded", value: `${year} (${now.getUTCFullYear() - year} years)` });
    }
    if (sheet.employeeCount !== null && sheet.employeeCount > 0) {
      facts.push({ id: "registry:employees", kind: "registry", label: "Employees", value: String(sheet.employeeCount) });
    }
    if (sheet.netRevenue !== null && sheet.netRevenue > 0n) {
      facts.push({
        id: "registry:revenue",
        kind: "registry",
        label: "Net revenue",
        value: `${formatFt(sheet.netRevenue)}${sheet.financialYear ? ` (${sheet.financialYear})` : ""}`,
      });
    }
    if (sheet.principalActivity?.label) {
      facts.push({ id: "registry:activity", kind: "registry", label: "Principal activity", value: sheet.principalActivity.label });
    }
    if (sheet.seat.city) {
      facts.push({ id: "registry:seat", kind: "registry", label: "Seat", value: sheet.seat.city });
    }
  }
  return facts;
}

/**
 * Does the candidate have anything a message could be honestly built on?
 *
 * The seat alone and the activity alone do not count: "a dental practice in
 * Budapest" describes ten thousand companies. An audit finding, a missing
 * website, or a concrete registry number (age, headcount, revenue) does.
 */
export function hasHook(facts: readonly CandidateFact[]): boolean {
  return facts.some(
    (f) => f.kind === "audit" || f.kind === "site" || ["registry:founded", "registry:employees", "registry:revenue"].includes(f.id),
  );
}
