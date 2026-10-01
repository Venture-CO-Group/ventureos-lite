/**
 * A datasheet or a search hit as the enrichment dialog's `RegistryCandidate`
 * (spec §4.19), so the existing confirm → enrich flow works unchanged on top
 * of Cégadat.
 */
import type { CompanyDatasheet } from "./datasheet";
import type { RegistrySearchHit } from "./cegadat";
import { cegadatTaxId } from "./cegadat";
import { REGISTRY_STATUS, type RegistryCandidate } from "./provider";
import { resolveSizeBand, SIZE_BAND_DEFS } from "@/modules/outbound/size-band";

/** The registry's status word → the flags the risk chip reads. */
export function statusFlagsFor(status: string | null): string[] {
  const s = (status ?? "").toLowerCase();
  if (!s) return [];
  if (s === "aktív") return [REGISTRY_STATUS.ACTIVE];
  if (s.includes("felszámol") || s.includes("végelszámol")) return [REGISTRY_STATUS.UNDER_LIQUIDATION];
  if (s.includes("végrehajt")) return [REGISTRY_STATUS.UNDER_ENFORCEMENT];
  if (s.includes("eljárás")) return [REGISTRY_STATUS.UNDER_PROCEEDINGS];
  if (s.includes("szünetel")) return ["suspended"];
  return [s];
}

function huf(n: bigint): string {
  const mrd = 1_000_000_000n;
  const m = 1_000_000n;
  if (n >= mrd) return `${(Number(n) / 1e9).toFixed(1).replace(/\.0$/, "")} Mrd Ft`;
  if (n >= m) return `${(n / m).toString()} M Ft`;
  return `${n.toString()} Ft`;
}

export function candidateFromSheet(sheet: CompanyDatasheet): RegistryCandidate {
  const size = resolveSizeBand({ employeeCount: sheet.employeeCount, netRevenue: sheet.netRevenue });
  const def = SIZE_BAND_DEFS.find((d) => d.band === size.band);
  return {
    legalName: sheet.legalName,
    taxId: cegadatTaxId(sheet.taxNumber) ?? sheet.taxNumber.replace(/\D/g, ""),
    regNumber: sheet.registryNumber,
    headcountBand:
      sheet.employeeCount !== null ? `${sheet.employeeCount} employees` : def ? `${def.label} (by revenue)` : null,
    revenueBand: sheet.netRevenue !== null ? `${huf(sheet.netRevenue)}${sheet.financialYear ? ` (${sheet.financialYear})` : ""}` : null,
    statusFlags: statusFlagsFor(sheet.status),
  };
}

export function candidateFromHit(hit: RegistrySearchHit): RegistryCandidate {
  return {
    legalName: hit.shortName ?? hit.fullName,
    taxId: cegadatTaxId(hit.taxNumber) ?? hit.taxNumber.replace(/\D/g, ""),
    regNumber: null,
    headcountBand: null,
    revenueBand: null,
    statusFlags: statusFlagsFor(hit.status),
  };
}
