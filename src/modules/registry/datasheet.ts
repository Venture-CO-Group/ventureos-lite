/**
 * A company datasheet in OUR terms (playbook-v6 F2, spec §4.43.4).
 *
 * The registry provider maps whatever its API returns onto this shape, and
 * nothing downstream — filtering, contact resolution, drafting, the hook
 * gate — ever sees a provider's field names. Swapping Cégadat for another
 * source is then a mapping, not a migration.
 *
 * Every field is nullable: coverage is partial, and an absent value must stay
 * distinguishable from a zero. Money is integer forints (CLAUDE.md), carried
 * as bigint because a large company's revenue does not fit an Int.
 */

export interface DatasheetPerson {
  name: string;
  /** "ügyvezető", "vezérigazgató", "cégvezető"… as the registry words it. */
  role: string | null;
}

export interface DatasheetActivity {
  code: string;
  label: string | null;
}

export interface CompanyDatasheet {
  taxNumber: string;
  legalName: string;
  shortName: string | null;
  /** "Kft.", "Zrt.", "Bt." … */
  legalForm: string | null;
  registryNumber: string | null;
  statisticalCode: string | null;
  /** The registry's own status word — "Aktív" for a live company. */
  status: string | null;
  foundedAt: string | null;
  seat: {
    county: string | null;
    city: string | null;
    zip: string | null;
    oneLine: string | null;
  };
  principalActivity: DatasheetActivity | null;
  activities: DatasheetActivity[];
  /** Latest financial year the figures below belong to. */
  financialYear: number | null;
  netRevenue: bigint | null;
  equity: bigint | null;
  operatingResult: bigint | null;
  preTaxResult: bigint | null;
  afterTaxResult: bigint | null;
  balanceSheetTotal: bigint | null;
  employeeCount: number | null;
  owners: DatasheetPerson[];
  managers: DatasheetPerson[];
  website: string | null;
  phone: string | null;
  email: string | null;
}

/** Every activity code on the sheet, principal first. */
export function activityCodes(sheet: Pick<CompanyDatasheet, "principalActivity" | "activities">): string[] {
  const out: string[] = [];
  if (sheet.principalActivity?.code) out.push(sheet.principalActivity.code);
  for (const a of sheet.activities) if (a.code && !out.includes(a.code)) out.push(a.code);
  return out;
}

/** The year a company was founded, when the sheet says. */
export function foundedYear(sheet: Pick<CompanyDatasheet, "foundedAt">): number | null {
  const m = /^(\d{4})/.exec(sheet.foundedAt ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * JSON-safe form for storage: bigint becomes a decimal string. `reviveDatasheet`
 * is the inverse; the pair is what a cached sheet round-trips through.
 */
export function serializeDatasheet(sheet: CompanyDatasheet): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(sheet, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v)),
  ) as Record<string, unknown>;
}

export function reviveDatasheet(raw: unknown): CompanyDatasheet | null {
  if (!raw || typeof raw !== "object") return null;
  return JSON.parse(JSON.stringify(raw), (_k, v) =>
    v && typeof v === "object" && typeof (v as { $bigint?: unknown }).$bigint === "string"
      ? BigInt((v as { $bigint: string }).$bigint)
      : v,
  ) as CompanyDatasheet;
}
