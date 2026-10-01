/**
 * Cégadat API (playbook-v6 F2, spec §4.43.4). Implemented against API v1.4
 * (2026-02-05); the contract as found is recorded in
 * docs/integrations/cegadat.md.
 *
 *   GET https://api.cegadatapi.hu/v1/search   — name / vatNumber / registryNumber;
 *                                                UNLIMITED on every plan.
 *   GET https://api.cegadatapi.hu/v1/detail   — `id` = 11-digit tax number;
 *                                                METERED (5,000/month on Haladó).
 *   Auth: `X-Api-Key` header.
 *
 * The search endpoint cannot filter by activity, size, revenue or county.
 * That is the constraint the whole outbound architecture is shaped around:
 * candidates come from free name searches, and filtering happens locally on
 * datasheets we paid for (§4.43.3, §4.43.5).
 *
 * Every response is mapped onto `CompanyDatasheet` here and nowhere else.
 * Every failure is classified here too: a quota answer must become a pause,
 * never a crash (CLAUDE.md hard rule 12).
 */
import type { CompanyDatasheet, DatasheetActivity, DatasheetPerson } from "./datasheet";

export const CEGADAT_BASE_URL = "https://api.cegadatapi.hu";
const TIMEOUT_MS = 10_000;

export type CegadatBusinessType =
  | "company"
  | "individualEntrepreneur"
  | "publicSector"
  | "nonProfit"
  | "otherOrganization"
  | "all";

export interface RegistrySearchParams {
  name?: string;
  vatNumber?: string;
  registryNumber?: string;
  businessType?: CegadatBusinessType;
  /** 0 typo-tolerant, 1 partial match, 2 exact. */
  sensitivity?: 0 | 1 | 2;
  status?: "Aktív" | "Eljárás alatt" | "Szüneteltetett";
  limit?: number;
  page?: number;
}

export interface RegistrySearchHit {
  taxNumber: string;
  fullName: string;
  shortName: string | null;
  status: string | null;
  businessType: string | null;
}

export interface RegistrySearchPage {
  hits: RegistrySearchHit[];
  page: number;
  totalPages: number;
  totalResults: number;
}

/** The plan's monthly limit was reached (error code 7, HTTP 429). */
export class RegistryQuotaError extends Error {
  constructor(message = "Registry package limit reached") {
    super(message);
    this.name = "RegistryQuotaError";
    Object.setPrototypeOf(this, RegistryQuotaError.prototype);
  }
}

/** The key, subscription or plan is not usable (codes 1, 5, 6). Do not retry. */
export class RegistryAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryAuthError";
    Object.setPrototypeOf(this, RegistryAuthError.prototype);
  }
}

/** Anything else: transient (code 3, network) or a bad request (2, 4). */
export class RegistryRequestError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RegistryRequestError";
    Object.setPrototypeOf(this, RegistryRequestError.prototype);
  }
}

export interface CompanyRegistryApi {
  readonly name: string;
  search(params: RegistrySearchParams): Promise<RegistrySearchPage>;
  /** Null when the registry knows no company with this tax number. */
  detail(taxNumber: string): Promise<CompanyDatasheet | null>;
}

// ---- mapping ----------------------------------------------------------------

/** Digits only; the 11-digit form the API takes ("12345678-2-42" → "12345678242"). */
export function cegadatTaxId(raw: string): string | null {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  return digits.length === 11 ? digits : null;
}

/** "12345678242" → "12345678-2-42", the form a person reads and a contract prints. */
export function formatTaxNumber(digits: string): string {
  const d = digits.replace(/[^0-9]/g, "");
  return d.length === 11 ? `${d.slice(0, 8)}-${d.slice(8, 9)}-${d.slice(9)}` : digits;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/**
 * Money arrives as a number on some sheets and as a string on others (both
 * are in the documentation's own examples). Either way it is whole forints.
 */
function money(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

function int(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** "6392. Egyéb információs szolgáltatás" → { code: "6392", label: "…" }. */
export function parseActivity(raw: unknown): DatasheetActivity | null {
  const s = str(raw);
  if (!s) return null;
  const m = /^(\d{2,6})\.?\s*(.*)$/.exec(s);
  if (!m) return { code: "", label: s };
  return { code: m[1]!, label: m[2]?.trim() || null };
}

function people(raw: unknown): DatasheetPerson[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => {
      if (typeof p === "string") return p.trim() ? { name: p.trim(), role: null } : null;
      if (p && typeof p === "object") {
        const o = p as Record<string, unknown>;
        const name = str(o.name ?? o.fullName);
        return name ? { name, role: str(o.role ?? o.position) } : null;
      }
      return null;
    })
    .filter((p): p is DatasheetPerson => p !== null);
}

/**
 * The registry spells the legal form out ("Korlátolt felelősségű társaság");
 * profiles and people use the abbreviation. A public company limited by
 * shares is an Nyrt. and a private one a Zrt. — the form is the same word,
 * so the full name decides.
 */
export function abbreviateLegalForm(form: string | null, fullName: string | null): string | null {
  if (!form) return null;
  const f = form.toLowerCase();
  if (f.includes("korlátolt felelősségű")) return "Kft.";
  if (f.includes("részvénytársaság")) {
    return /nyilvánosan működő/i.test(fullName ?? "") ? "Nyrt." : "Zrt.";
  }
  if (f.includes("betéti")) return "Bt.";
  if (f.includes("közkereseti")) return "Kkt.";
  if (f.includes("egyéni vállalkozás")) return "e.v.";
  if (f.includes("egyéni cég")) return "e.c.";
  if (f.includes("szövetkezet")) return "Szöv.";
  if (f.includes("egyesülés")) return "Egyesülés";
  if (f.includes("alapítvány")) return "Alapítvány";
  if (f.includes("egyesület")) return "Egyesület";
  return form;
}

/** A website as the registry writes it ("www.x.hu") → a URL we can fetch. */
function website(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`;
}

export function mapCegadatDetail(r: Record<string, unknown>): CompanyDatasheet {
  const fullName = str(r.fullName) ?? "";
  const activities = (Array.isArray(r.activities) ? r.activities : [])
    .map(parseActivity)
    .filter((a): a is DatasheetActivity => a !== null);
  const reportYear = /^(\d{4})/.exec(str(r.reportDate) ?? "");
  return {
    taxNumber: formatTaxNumber(str(r.vatNumber) ?? ""),
    legalName: fullName,
    shortName: str(r.shortName),
    legalForm: abbreviateLegalForm(str(r.legalForm), fullName),
    registryNumber: str(r.registryNumber),
    statisticalCode: str(r.statisticalCode),
    status: str(r.status),
    foundedAt: str(r.dateFounded),
    seat: {
      county: str(r.addressCounty),
      city: str(r.addressCity),
      zip: str(r.addressPostalCode),
      oneLine: str(r.fullAddress),
    },
    principalActivity: parseActivity(r.principalActivity),
    activities,
    financialYear: reportYear ? Number(reportYear[1]) : null,
    // Sole traders report `revenue` / `netIncome` instead of the company set.
    netRevenue: money(r.netRevenue) ?? money(r.revenue),
    equity: money(r.shareholdersEquity),
    operatingResult: money(r.operatingProfit),
    preTaxResult: money(r.earningsBeforeTaxes),
    /**
     * `netSalesRevenues` is, despite its name, the after-tax result: on every
     * captured sheet it sits just below `earningsBeforeTaxes` (Coca-Cola HBC
     * 10.44bn → 9.54bn; a holding at −20.46bn → −20.50bn), never near net
     * revenue. Mapped by what it measures, not what it is called.
     */
    afterTaxResult: money(r.netSalesRevenues) ?? money(r.netIncome),
    balanceSheetTotal: money(r.totalAssets),
    employeeCount: int(r.employeeCount),
    owners: people(r.owners),
    managers: people(r.managers),
    website: website(r.website),
    phone: str(r.phoneNumber),
    email: str(r.emailAddress)?.toLowerCase() ?? null,
  };
}

export function mapCegadatSearchHit(r: Record<string, unknown>): RegistrySearchHit | null {
  const vat = str(r.vatNumber ?? r.id);
  const fullName = str(r.fullName);
  if (!vat || !fullName) return null;
  return {
    taxNumber: formatTaxNumber(vat),
    fullName,
    shortName: str(r.shortName),
    status: str(r.status),
    businessType: str(r.businessType),
  };
}

// ---- the client --------------------------------------------------------------

interface Envelope {
  status?: boolean;
  error?: string;
  errorCode?: number;
  statusCode?: number;
  response?: {
    meta?: { current?: number; total_pages?: number; total_results?: number };
    results?: unknown;
  };
}

function classify(env: Envelope | null, httpStatus: number): Error {
  const code = env?.errorCode ?? null;
  const message = env?.error ?? `HTTP ${httpStatus}`;
  if (code === 7 || httpStatus === 429) return new RegistryQuotaError(message);
  if (code === 1 || code === 5 || code === 6 || httpStatus === 401) {
    return new RegistryAuthError(`Cégadat refused the key (${code ?? httpStatus}): ${message}`);
  }
  // 3 is the provider's own failure and worth a retry; 2 and 4 are ours.
  const retryable = code === 3 || httpStatus >= 500;
  return new RegistryRequestError(`Cégadat error ${code ?? httpStatus}: ${message}`, code, retryable);
}

export class CegadatProvider implements CompanyRegistryApi {
  readonly name = "cegadat";

  constructor(
    private readonly apiKey: string,
    private readonly doFetch: typeof fetch = fetch,
    private readonly baseUrl: string = CEGADAT_BASE_URL,
  ) {}

  private async get(path: string, params: Record<string, string>): Promise<Envelope> {
    const url = `${this.baseUrl}${path}?${new URLSearchParams(params).toString()}`;
    let res: Response;
    try {
      res = await this.doFetch(url, {
        headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new RegistryRequestError(`Cégadat unreachable: ${(e as Error).message}`, null, true);
    }
    let env: Envelope | null = null;
    try {
      env = (await res.json()) as Envelope;
    } catch {
      env = null;
    }
    if (!res.ok || !env || env.status === false) throw classify(env, res.status);
    return env;
  }

  async search(p: RegistrySearchParams): Promise<RegistrySearchPage> {
    const params: Record<string, string> = {};
    if (p.name) {
      // The API refuses fewer than four characters (error 4). Refusing here
      // costs nothing and gives the caller a reason it can act on.
      if (p.name.trim().length < 4) {
        throw new RegistryRequestError("A name search needs at least four characters.", 4, false);
      }
      params.name = p.name.trim();
    }
    if (p.vatNumber) {
      const id = cegadatTaxId(p.vatNumber);
      if (!id) throw new RegistryRequestError("Not an 11-digit tax number.", 2, false);
      params.vatNumber = id;
    }
    if (p.registryNumber) params.registryNumber = p.registryNumber.replace(/[^0-9]/g, "");
    if (p.businessType) params.businessType = p.businessType;
    if (p.sensitivity !== undefined) params.sensitivity = String(p.sensitivity);
    if (p.status) params.status = p.status;
    if (p.limit) params.limit = String(Math.max(1, Math.min(100, p.limit)));
    if (p.page) params.page = String(p.page);

    const env = await this.get("/v1/search", params);
    const results = Array.isArray(env.response?.results) ? (env.response!.results as unknown[]) : [];
    const meta = env.response?.meta ?? {};
    return {
      hits: results
        .map((r) => (r && typeof r === "object" ? mapCegadatSearchHit(r as Record<string, unknown>) : null))
        .filter((h): h is RegistrySearchHit => h !== null),
      page: meta.current ?? p.page ?? 1,
      totalPages: meta.total_pages ?? 1,
      totalResults: meta.total_results ?? results.length,
    };
  }

  async detail(taxNumber: string): Promise<CompanyDatasheet | null> {
    const id = cegadatTaxId(taxNumber);
    if (!id) throw new RegistryRequestError("Not an 11-digit tax number.", 2, false);
    const env = await this.get("/v1/detail", { id });
    const r = env.response?.results;
    // An unknown tax number answers 200 with an EMPTY results array.
    if (!r || Array.isArray(r) || typeof r !== "object") return null;
    return mapCegadatDetail(r as Record<string, unknown>);
  }
}
