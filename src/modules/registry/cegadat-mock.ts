/**
 * A Cégadat stand-in for development without a key (playbook-v6 F2).
 *
 * Built-in companies shaped exactly like mapped datasheets, so the outbound
 * pipeline can run end to end on a laptop. Searches match name fragments the
 * way `sensitivity=1` does — a partial, case-insensitive match — which is the
 * only search mode the harvest uses. Never used in production: the resolver
 * refuses it there.
 */
import type { CompanyDatasheet } from "./datasheet";
import type { CompanyRegistryApi, RegistrySearchPage, RegistrySearchParams } from "./cegadat";
import { cegadatTaxId, formatTaxNumber } from "./cegadat";

function sheet(over: Partial<CompanyDatasheet> & Pick<CompanyDatasheet, "taxNumber" | "legalName">): CompanyDatasheet {
  return {
    shortName: over.legalName,
    legalForm: "Kft.",
    registryNumber: null,
    statisticalCode: null,
    status: "Aktív",
    foundedAt: "2014-05-02",
    seat: { county: "Budapest", city: "Budapest", zip: "1111", oneLine: "1111 Budapest, Minta utca 1." },
    principalActivity: null,
    activities: [],
    financialYear: 2025,
    netRevenue: null,
    equity: null,
    operatingResult: null,
    preTaxResult: null,
    afterTaxResult: null,
    balanceSheetTotal: null,
    employeeCount: null,
    owners: [],
    managers: [],
    website: null,
    phone: null,
    email: null,
    ...over,
  };
}

export const MOCK_DATASHEETS: readonly CompanyDatasheet[] = [
  sheet({
    taxNumber: "11111111-2-41",
    legalName: "Mosoly Fogászati Kft.",
    principalActivity: { code: "8623", label: "Fogorvosi járóbeteg-ellátás" },
    activities: [{ code: "8623", label: "Fogorvosi járóbeteg-ellátás" }],
    netRevenue: 210_000_000n,
    employeeCount: 12,
    managers: [{ name: "Dr. Minta Éva", role: null }],
    website: "https://mosolyfogaszat.example",
    email: "info@mosolyfogaszat.example",
  }),
  sheet({
    taxNumber: "22222222-2-42",
    legalName: "Belvárosi Magánklinika Zrt.",
    legalForm: "Zrt.",
    principalActivity: { code: "8622", label: "Szakorvosi járóbeteg-ellátás" },
    netRevenue: 1_900_000_000n,
    employeeCount: 64,
    managers: [{ name: "Dr. Teszt Gábor", role: null }],
    website: "https://belvarosiklinika.example",
  }),
  sheet({
    taxNumber: "33333333-2-43",
    legalName: "Duna Logisztika Kft.",
    principalActivity: { code: "4941", label: "Közúti áruszállítás" },
    netRevenue: 640_000_000n,
    employeeCount: 31,
    managers: [{ name: "Próba Péter", role: null }],
    email: "iroda@dunalogisztika.example",
  }),
  sheet({
    taxNumber: "44444444-2-44",
    legalName: "Kis Gombóc Étterem Bt.",
    legalForm: "Bt.",
    principalActivity: { code: "5610", label: "Éttermi vendéglátás" },
    netRevenue: 48_000_000n,
    employeeCount: 4,
    managers: [{ name: "Gombóc Gizella", role: null }],
  }),
  sheet({
    taxNumber: "55555555-2-41",
    legalName: "Régi Rendelő Egészségközpont Kft.",
    status: "Eljárás alatt",
    principalActivity: { code: "8621", label: "Általános járóbeteg-ellátás" },
    employeeCount: 8,
  }),
];

export class MockCegadatProvider implements CompanyRegistryApi {
  readonly name = "mock";

  constructor(private readonly sheets: readonly CompanyDatasheet[] = MOCK_DATASHEETS) {}

  async search(p: RegistrySearchParams): Promise<RegistrySearchPage> {
    let hits = this.sheets;
    if (p.vatNumber) {
      const id = cegadatTaxId(p.vatNumber);
      hits = hits.filter((s) => cegadatTaxId(s.taxNumber) === id);
    }
    if (p.name) {
      const q = p.name.trim().toLowerCase();
      hits = hits.filter((s) => s.legalName.toLowerCase().includes(q));
    }
    if (p.status) hits = hits.filter((s) => s.status === p.status);
    const limit = p.limit ?? 50;
    const page = p.page ?? 1;
    const slice = hits.slice((page - 1) * limit, page * limit);
    return {
      hits: slice.map((s) => ({
        taxNumber: formatTaxNumber(cegadatTaxId(s.taxNumber) ?? s.taxNumber),
        fullName: s.legalName,
        shortName: s.shortName,
        status: s.status,
        businessType: "Társas vállalkozás",
      })),
      page,
      totalPages: Math.max(1, Math.ceil(hits.length / limit)),
      totalResults: hits.length,
    };
  }

  async detail(taxNumber: string): Promise<CompanyDatasheet | null> {
    const id = cegadatTaxId(taxNumber);
    return this.sheets.find((s) => cegadatTaxId(s.taxNumber) === id) ?? null;
  }
}
