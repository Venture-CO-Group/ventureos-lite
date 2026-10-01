/**
 * The seeded segment taxonomy (spec §4.43.2a, §9bis).
 *
 * Nineteen segments, each with three things behind its plain-language name:
 *
 *   - a TEÁOR set, matched by PREFIX against a datasheet's activity codes
 *     ("86" covers every human-health activity, "8623" only dentistry). The
 *     two-digit divisions are shared by TEÁOR'08 and TEÁOR'25, which is why
 *     most entries stop there — a registry answering in either scheme still
 *     matches.
 *   - name fragments: words that genuinely occur in Hungarian company names,
 *     four characters or more — the search endpoint refuses shorter terms.
 *     These drive the free `/v1/search` harvest, so they are the main lever
 *     on candidate quality and are measured per fragment (§4.43.10).
 *   - a sourcing hint: which channel actually carries the segment. Fantasy-
 *     named sectors (IT, consulting, manufacturing, wholesale) are marked weak
 *     so nobody expects the harvest to find them; finite-universe sectors
 *     (banks, insurers) carry a seed list instead.
 *
 * Seed lists name institutions as they are commonly registered. They are a
 * starting point, resolved to tax numbers through `/v1/search` — a name that
 * no longer resolves is reported, not guessed at. All of it is editable per
 * workspace; this file is only what a new workspace starts with.
 */
import type { SourcingHint } from "@prisma/client";

export interface SeedEntry {
  name?: string;
  taxNumber?: string;
}

export interface SegmentSeed {
  key: string;
  name: string;
  teaorInclude: string[];
  teaorExclude: string[];
  fragments: string[];
  seedList: SeedEntry[];
  sourcingHint: SourcingHint;
}

const names = (...n: string[]): SeedEntry[] => n.map((name) => ({ name }));

export const DEFAULT_SEGMENTS: readonly SegmentSeed[] = [
  {
    key: "insurers",
    name: "Insurers",
    teaorInclude: ["65", "662"],
    teaorExclude: [],
    fragments: [
      "biztosító",
      "biztosítás",
      "biztosítási",
      "életbiztosító",
      "insurance",
      "assurance",
      "alkusz",
      "biztosításközvetítő",
      "kölcsönös biztosító",
      "biztosítási egyesület",
    ],
    seedList: names(
      "Allianz Hungária Biztosító Zrt.",
      "Generali Biztosító Zrt.",
      "Groupama Biztosító Zrt.",
      "UNION Vienna Insurance Group Biztosító Zrt.",
      "Alfa Vienna Insurance Group Biztosító Zrt.",
      "UNIQA Biztosító Zrt.",
      "K&H Biztosító Zrt.",
      "Signal Iduna Biztosító Zrt.",
      "CIG Pannónia Életbiztosító Nyrt.",
      "Magyar Posta Biztosító Zrt.",
      "Magyar Posta Életbiztosító Zrt.",
      "Grawe Biztosító Zrt.",
      "Gránit Biztosító Zrt.",
      "MBH Biztosító Zrt.",
      "KÖBE Közép-európai Kölcsönös Biztosító Egyesület",
      "Genertel Biztosító Zrt.",
    ),
    sourcingHint: "SEED_LIST",
  },
  {
    key: "banks_financial",
    name: "Banks & financial institutions",
    teaorInclude: ["64", "661"],
    teaorExclude: ["6420"],
    fragments: [
      "bank",
      "takarék",
      "pénzügyi",
      "finance",
      "hitel",
      "lízing",
      "leasing",
      "befektetési",
      "faktor",
      "pénzintézet",
      "fintech",
      "capital",
    ],
    seedList: names(
      "OTP Bank Nyrt.",
      "MBH Bank Nyrt.",
      "K&H Bank Zrt.",
      "Erste Bank Hungary Zrt.",
      "Raiffeisen Bank Zrt.",
      "UniCredit Bank Hungary Zrt.",
      "CIB Bank Zrt.",
      "Gránit Bank Zrt.",
      "MagNet Magyar Közösségi Bank Zrt.",
      "KDB Bank Európa Zrt.",
      "Bank of China (Hungária) Zrt.",
      "Magyar Export-Import Bank Zrt.",
      "MFB Magyar Fejlesztési Bank Zrt.",
      "Merkantil Bank Zrt.",
      "Sberbank Magyarország Zrt.",
    ),
    sourcingHint: "SEED_LIST",
  },
  {
    key: "private_clinics",
    name: "Private clinics & healthcare",
    teaorInclude: ["86"],
    teaorExclude: [],
    fragments: [
      "klinika",
      "rendelő",
      "fogászat",
      "fogászati",
      "egészségközpont",
      "medical",
      "med center",
      "orvosi",
      "magánorvosi",
      "diagnosztika",
      "labor",
      "fogorvos",
      "dental",
      "szemészet",
      "egészségügyi",
      "gyógyközpont",
      "rehabilitáció",
      "ortopédia",
    ],
    seedList: [],
    sourcingHint: "NAME_HARVEST_STRONG",
  },
  {
    key: "pharmacies",
    name: "Pharmacies",
    teaorInclude: ["4773", "4646"],
    teaorExclude: [],
    fragments: ["gyógyszertár", "patika", "gyógyszer", "pharma", "gyógyáru", "gyógyszerkereskedelmi"],
    seedList: [],
    sourcingHint: "NAME_HARVEST_STRONG",
  },
  {
    key: "logistics",
    name: "Logistics & haulage",
    teaorInclude: ["494", "52", "53"],
    teaorExclude: [],
    fragments: [
      "logisztika",
      "logisztikai",
      "logistics",
      "szállítmányozás",
      "szállítmányozási",
      "fuvar",
      "fuvarozás",
      "fuvarozó",
      "trans",
      "transport",
      "spedíció",
      "raktározás",
      "cargo",
      "futár",
      "freight",
    ],
    seedList: [],
    sourcingHint: "NAME_HARVEST_STRONG",
  },
  {
    key: "manufacturing",
    name: "Manufacturing",
    teaorInclude: ["10", "11", "13", "14", "15", "16", "17", "18", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33"],
    teaorExclude: [],
    fragments: [
      "gyártó",
      "gyártás",
      "ipari",
      "üzem",
      "manufacturing",
      "termelő",
      "gépgyártó",
      "fémipari",
      "műanyag",
      "precíziós",
      "industries",
      "factory",
    ],
    seedList: [],
    sourcingHint: "NAME_HARVEST_WEAK",
  },
  {
    key: "wholesale",
    name: "Wholesale",
    teaorInclude: ["46"],
    teaorExclude: ["4646"],
    fragments: [
      "nagykereskedelmi",
      "nagykereskedés",
      "kereskedelmi",
      "trade",
      "trading",
      "disztribúció",
      "distribution",
      "import",
      "export",
      "beszállító",
    ],
    seedList: [],
    sourcingHint: "NAME_HARVEST_WEAK",
  },
  {
    key: "construction",
    name: "Construction",
    teaorInclude: ["41", "42", "43"],
    teaorExclude: [],
    fragments: [
      "építő",
      "építőipari",
      "építés",
      "construction",
      "kivitelező",
      "generálkivitelező",
      "épületgépészet",
      "szigetelés",
      "tetőfedő",
      "burkoló",
      "mélyépítő",
    ],
    seedList: [],
    sourcingHint: "NAME_HARVEST_STRONG",
  },
  {
    key: "hospitality",
    name: "Hospitality",
    teaorInclude: ["55", "56"],
    teaorExclude: [],
    fragments: [
      "étterem",
      "vendéglő",
      "bisztró",
      "kávéház",
      "cukrászda",
      "hotel",
      "szálloda",
      "panzió",
      "catering",
      "pizzéria",
      "gasztro",
      "vendéglátó",
    ],
    seedList: [],
    sourcingHint: "PLACES",
  },
  {
    key: "retail",
    name: "Retail",
    teaorInclude: ["47"],
    teaorExclude: ["4773"],
    fragments: ["üzlet", "bolt", "áruház", "kiskereskedelmi", "shop", "store", "divat", "butik", "webáruház"],
    seedList: [],
    sourcingHint: "PLACES",
  },
  {
    key: "it_software",
    name: "IT & software",
    teaorInclude: ["62", "63", "582"],
    teaorExclude: [],
    fragments: [
      "szoftver",
      "software",
      "informatikai",
      "informatika",
      "digital",
      "rendszerház",
      "solutions",
      "systems",
      "cloud",
      "data",
    ],
    seedList: [],
    sourcingHint: "NAME_HARVEST_WEAK",
  },
  {
    key: "consulting_accounting",
    name: "Consulting & accounting",
    teaorInclude: ["692", "702"],
    teaorExclude: [],
    fragments: [
      "könyvelő",
      "könyvelés",
      "könyvviteli",
      "adótanácsadó",
      "tanácsadó",
      "consulting",
      "accounting",
      "bérszámfejtés",
      "könyvszakértő",
    ],
    seedList: [],
    sourcingHint: "NAME_HARVEST_WEAK",
  },
  {
    key: "law_firms",
    name: "Law firms",
    teaorInclude: ["691"],
    teaorExclude: [],
    fragments: ["ügyvédi iroda", "ügyvédi", "ügyvéd", "legal", "jogi", "közjegyzői"],
    seedList: [],
    sourcingHint: "NAME_HARVEST_STRONG",
  },
  {
    key: "real_estate",
    name: "Real estate",
    teaorInclude: ["68"],
    teaorExclude: [],
    fragments: [
      "ingatlan",
      "real estate",
      "property",
      "ingatlanforgalmazó",
      "ingatlankezelő",
      "társasházkezelő",
      "lakópark",
      "ingatlanfejlesztő",
    ],
    seedList: [],
    sourcingHint: "NAME_HARVEST_STRONG",
  },
  {
    key: "education",
    name: "Education",
    teaorInclude: ["85"],
    teaorExclude: [],
    fragments: [
      "oktatási",
      "oktatás",
      "iskola",
      "nyelviskola",
      "képzés",
      "képző",
      "akadémia",
      "academy",
      "tréning",
      "training",
      "autósiskola",
    ],
    seedList: [],
    sourcingHint: "NAME_HARVEST_STRONG",
  },
  {
    key: "travel_tourism",
    name: "Travel & tourism",
    teaorInclude: ["79", "552"],
    teaorExclude: [],
    fragments: ["utazási iroda", "utazási", "travel", "tours", "tour", "turisztikai", "idegenforgalmi", "utazásszervező"],
    seedList: [],
    sourcingHint: "NAME_HARVEST_STRONG",
  },
  {
    key: "automotive",
    name: "Automotive",
    teaorInclude: ["45", "29"],
    teaorExclude: [],
    fragments: [
      "autó",
      "autószerviz",
      "gépjármű",
      "autóház",
      "auto",
      "karosszéria",
      "gumiszerviz",
      "autókereskedés",
      "autóalkatrész",
      "motor",
    ],
    seedList: [],
    sourcingHint: "NAME_HARVEST_STRONG",
  },
  {
    key: "energy",
    name: "Energy",
    teaorInclude: ["35", "4321"],
    teaorExclude: [],
    fragments: ["energia", "energy", "napelem", "solar", "villamos", "megújuló", "erőmű", "power", "energetikai", "gázszolgáltató"],
    seedList: [],
    sourcingHint: "NAME_HARVEST_STRONG",
  },
  {
    key: "agriculture",
    name: "Agriculture",
    teaorInclude: ["01", "02", "03"],
    teaorExclude: [],
    fragments: [
      "mezőgazdasági",
      "agrár",
      "agro",
      "farm",
      "kertészet",
      "állattenyésztő",
      "növénytermesztő",
      "szőlészet",
      "pincészet",
      "gazdaság",
    ],
    seedList: [],
    sourcingHint: "NAME_HARVEST_STRONG",
  },
];

export const SOURCING_HINT_LABEL: Record<SourcingHint, string> = {
  NAME_HARVEST_STRONG: "name harvest",
  NAME_HARVEST_WEAK: "name harvest (weak — fantasy names)",
  SEED_LIST: "seed list",
  PLACES: "Google Places",
};

/** TEÁOR codes are compared without dots or spaces: "86.23" ≡ "8623". */
export function normalizeTeaor(code: string): string {
  return code.replace(/[^0-9]/g, "");
}

/**
 * Does any of a company's activity codes fall inside a segment?
 *
 * Exclusions win over inclusions, so "wholesale except pharmaceuticals" is
 * expressible without a second segment.
 */
export function teaorMatches(
  codes: readonly string[],
  segment: { teaorInclude: readonly string[]; teaorExclude: readonly string[] },
): string | null {
  const include = segment.teaorInclude.map(normalizeTeaor).filter(Boolean);
  const exclude = segment.teaorExclude.map(normalizeTeaor).filter(Boolean);
  for (const raw of codes) {
    const code = normalizeTeaor(raw);
    if (!code) continue;
    if (exclude.some((p) => code.startsWith(p))) continue;
    if (include.some((p) => code.startsWith(p))) return raw;
  }
  return null;
}
