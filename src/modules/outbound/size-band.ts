/**
 * Size bands (spec §4.43.2b) — the EU definition, read off the registry.
 *
 * Headcount decides. When it is missing, net revenue decides against each
 * band's revenue ceiling. When both are missing the company is "size
 * unknown": it is neither silently dropped nor silently let in — the profile
 * says which, and either way the candidate carries the flag so a reviewer
 * knows the size was never established.
 *
 * Pure, so the fixture table in the tests is the specification.
 */

export const SIZE_BANDS = ["MICRO", "SMALL", "MEDIUM", "LARGE"] as const;
export type SizeBand = (typeof SIZE_BANDS)[number];

export interface SizeBandDef {
  band: SizeBand;
  label: string;
  minEmployees: number;
  /** Inclusive upper headcount; null for the open-ended top band. */
  maxEmployees: number | null;
  /**
   * Exclusive revenue ceiling in forints, used only when headcount is
   * missing. Null for the top band: anything above the medium ceiling is large.
   */
  revenueCeiling: bigint | null;
}

const MRD = 1_000_000_000n;

export const SIZE_BAND_DEFS: readonly SizeBandDef[] = [
  { band: "MICRO", label: "Micro (1–9)", minEmployees: 0, maxEmployees: 9, revenueCeiling: 1n * MRD },
  { band: "SMALL", label: "Small (10–49)", minEmployees: 10, maxEmployees: 49, revenueCeiling: 5n * MRD },
  { band: "MEDIUM", label: "Medium (50–249)", minEmployees: 50, maxEmployees: 249, revenueCeiling: 25n * MRD },
  { band: "LARGE", label: "Large (250+)", minEmployees: 250, maxEmployees: null, revenueCeiling: null },
];

export type SizeBasis = "employees" | "revenue" | "unknown";

export interface ResolvedSize {
  band: SizeBand | null;
  basis: SizeBasis;
}

function toBigInt(v: bigint | number | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v;
  if (!Number.isFinite(v)) return null;
  return BigInt(Math.trunc(v));
}

/**
 * Which band a company is in, and on what evidence.
 *
 * A headcount of 0 is a real answer — holding companies and one-person firms
 * report it — and lands in MICRO, as the EU definition does. Only an ABSENT
 * headcount falls through to revenue.
 */
export function resolveSizeBand(input: {
  employeeCount?: number | null;
  netRevenue?: bigint | number | null;
}): ResolvedSize {
  const employees = input.employeeCount;
  if (employees !== null && employees !== undefined && Number.isFinite(employees) && employees >= 0) {
    const def = SIZE_BAND_DEFS.find(
      (d) => employees >= d.minEmployees && (d.maxEmployees === null || employees <= d.maxEmployees),
    );
    return { band: def!.band, basis: "employees" };
  }

  const revenue = toBigInt(input.netRevenue);
  if (revenue !== null && revenue >= 0n) {
    const def = SIZE_BAND_DEFS.find((d) => d.revenueCeiling === null || revenue < d.revenueCeiling);
    return { band: def!.band, basis: "revenue" };
  }

  return { band: null, basis: "unknown" };
}

export type SizeVerdict =
  | { ok: true; band: SizeBand | null; basis: SizeBasis; unknownSize: boolean }
  | { ok: false; band: SizeBand | null; basis: SizeBasis; reason: string };

/**
 * Does a company's size fit a profile? An empty band list means "any size".
 *
 * The refusal reason names the measured value, because "filtered: size" says
 * nothing about whether the source or the profile is wrong.
 */
export function checkSize(
  profile: { sizeBands: readonly SizeBand[]; includeUnknownSize: boolean },
  company: { employeeCount?: number | null; netRevenue?: bigint | number | null },
): SizeVerdict {
  const resolved = resolveSizeBand(company);
  if (resolved.band === null) {
    if (profile.sizeBands.length === 0 || profile.includeUnknownSize) {
      return { ok: true, band: null, basis: "unknown", unknownSize: true };
    }
    return {
      ok: false,
      band: null,
      basis: "unknown",
      reason: "size unknown (no headcount, no revenue) and the profile excludes unknown sizes",
    };
  }
  if (profile.sizeBands.length === 0 || profile.sizeBands.includes(resolved.band)) {
    return { ok: true, band: resolved.band, basis: resolved.basis, unknownSize: false };
  }
  const measured =
    resolved.basis === "employees"
      ? `employeeCount ${company.employeeCount}`
      : `net revenue ${toBigInt(company.netRevenue)?.toString()} Ft`;
  return {
    ok: false,
    band: resolved.band,
    basis: resolved.basis,
    reason: `${measured} → ${resolved.band}, profile wants ${profile.sizeBands.join("/")}`,
  };
}

export function parseSizeBands(raw: unknown): SizeBand[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is SizeBand => (SIZE_BANDS as readonly string[]).includes(v as string));
}
