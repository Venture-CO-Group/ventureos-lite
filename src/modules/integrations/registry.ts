/**
 * What is configurable from the UI, and what is not. Pure — no I/O — so the
 * classification and the Mailgun invariant are testable on their own.
 *
 * The split is the important part:
 *
 *   INTEGRATION credentials (below) are per-workspace and editable in Settings.
 *   They are things an operator legitimately rotates: API keys, sending domains.
 *
 *   INFRASTRUCTURE settings are env-only and shown read-only. Editing a
 *   database URL or the encryption key from inside the app that depends on them
 *   is a way to lock yourself out of your own installation — and CREDENTIALS_KEY
 *   in particular is what protects everything on the editable list.
 */

export type FieldKind = "secret" | "plain";

export interface IntegrationField {
  /** Stable storage key. Never change one without a migration. */
  key: string;
  label: string;
  kind: FieldKind;
  /** Env variable consulted when the workspace has no value of its own. */
  envVar: string;
  placeholder?: string;
  help?: string;
}

export interface IntegrationGroup {
  id: string;
  title: string;
  description: string;
  fields: IntegrationField[];
  /** Whether a "Test connection" button makes sense for this group. */
  testable: boolean;
}

export const INTEGRATION_GROUPS: IntegrationGroup[] = [
  {
    id: "anthropic",
    title: "Anthropic (Claude)",
    description: "Powers research cards, drafts, briefs and the weekly analysis.",
    testable: true,
    fields: [
      {
        key: "anthropic.apiKey",
        label: "API key",
        kind: "secret",
        envVar: "ANTHROPIC_API_KEY",
        placeholder: "sk-ant-…",
        help: "console.anthropic.com → Settings → API keys",
      },
    ],
  },
  {
    id: "google",
    title: "Google APIs",
    description: "Prospector search and website-audit performance scores.",
    testable: true,
    fields: [
      {
        key: "google.placesApiKey",
        label: "Places API key",
        kind: "secret",
        envVar: "GOOGLE_PLACES_API_KEY",
        help: "Google Cloud → Credentials, with Places API (New) enabled",
      },
      {
        key: "google.pagespeedApiKey",
        label: "PageSpeed API key",
        kind: "secret",
        envVar: "PAGESPEED_API_KEY",
        help: "Same project, with PageSpeed Insights API enabled",
      },
      {
        key: "google.cruxApiKey",
        label: "Chrome UX Report API key (optional)",
        kind: "secret",
        envVar: "CRUX_API_KEY",
        help:
          "Only needed if the CrUX API lives in a different project — otherwise the PageSpeed key is reused. Enable 'Chrome UX Report API'.",
      },
    ],
  },
  {
    id: "serp",
    title: "SERP provider (rank tracking)",
    description:
      "Optional. Weekly keyword positions for clients. Without it the feature stays dormant — we never scrape Google.",
    testable: false,
    fields: [
      {
        key: "serp.credential",
        label: "DataForSEO credential (login:password)",
        kind: "secret",
        envVar: "SERP_CREDENTIAL",
        help: "Billed per query. The cost projection in the app uses their per-task price.",
      },
    ],
  },
  {
    id: "mailgun_transactional",
    title: "Mailgun — transactional",
    description: "Quotes, contracts, certificates, booking confirmations.",
    testable: true,
    fields: [
      {
        key: "mailgun.tx.domain",
        label: "Sending domain",
        kind: "plain",
        envVar: "MAILGUN_DOMAIN",
        placeholder: "mg.ventureco.group",
      },
      {
        key: "mailgun.tx.apiKey",
        label: "Sending API key",
        kind: "secret",
        envVar: "MAILGUN_API_KEY",
      },
      {
        key: "mailgun.webhookSigningKey",
        label: "Webhook signing key",
        kind: "secret",
        envVar: "MAILGUN_WEBHOOK_SIGNING_KEY",
        help: "Verifies delivery and bounce callbacks are really from Mailgun",
      },
    ],
  },
  {
    id: "mailgun_cold",
    title: "Mailgun — cold outreach",
    description:
      "A SEPARATE domain and key. A cold-list complaint must never touch the reputation quotes and contracts depend on.",
    testable: true,
    fields: [
      {
        key: "mailgun.cold.domain",
        label: "Cold sending domain",
        kind: "plain",
        envVar: "MAILGUN_COLD_DOMAIN",
        placeholder: "cold.ventureco.agency",
      },
      {
        key: "mailgun.cold.apiKey",
        label: "Cold sending API key",
        kind: "secret",
        envVar: "MAILGUN_COLD_API_KEY",
      },
    ],
  },
  {
    id: "szamlazz",
    title: "Számlázz.hu",
    description: "Invoice submission. Per-workspace Számla Agent key.",
    testable: false,
    fields: [
      {
        key: "szamlazz.agentKey",
        label: "Számla Agent key",
        kind: "secret",
        envVar: "",
        help: "Számlázz.hu → Beállítások → Számla Agent kulcs",
      },
    ],
  },
  {
    id: "verifier",
    title: "E-mail-cím ellenőrző (opcionális)",
    description:
      "Csak akkor kell, ha hideg kampányt indítasz. Nélküle is fut minden ellenőrzés — helyesírás, eldobható postafiók, szerep-cím, MX-rekord —, ez a szolgáltatás annyit tesz hozzá, hogy a postafiók létezését is megerősíti, címenként pár tized centért. ZeroBounce API-kulcs.",
    // Nothing to test on its own: the check that matters is a real address,
    // and the campaign audience screen already shows what it decided.
    testable: false,
    fields: [
      {
        key: "verifier.apiKey",
        label: "ZeroBounce API-kulcs",
        kind: "secret",
        envVar: "VERIFIER_API_KEY",
        placeholder: "üresen hagyva a beépített ellenőrzések futnak",
        help: "zerobounce.net → API → API Key. Üresen hagyva semmi nem megy ki külső szolgáltatóhoz.",
      },
    ],
  },
  {
    id: "cegadat",
    title: "Cégadat API (cégadatlapok)",
    description:
      "A kimenő motor és a cégadat-gazdagítás forrása: TEÁOR, árbevétel, létszám, vezetők, elérhetőségek. A keresés korlátlan, az adatlap-lekérés havi kerethez kötött (Haladó: 5000) — a keret napi elosztását és a tartalékot a Kimenő beállításoknál látod.",
    testable: true,
    fields: [
      {
        key: "cegadat.apiKey",
        label: "API-kulcs",
        kind: "secret",
        envVar: "CEGADAT_API_KEY",
        help: "cegadatapi.hu → Fiók → API-kulcs. A teszteléshez a dokumentációban közölt tesztkulcs is működik.",
      },
    ],
  },
  {
    id: "nav",
    title: "NAV Online Számla (cégadatok)",
    description:
      "Ingyenes és hivatalos: a cég jogi neve, székhelye és adózói státusza a NAV nyilvántartásából. Ez váltja ki a fizetős céginformációs előfizetést — enélkül a keresésből származó adat marad, ami nem hiteles.",
    testable: true,
    fields: [
      {
        key: "nav.login",
        label: "Technikai felhasználó",
        kind: "plain",
        envVar: "NAV_LOGIN",
        placeholder: "15 karakter",
        help: "onlineszamla.nav.gov.hu → Felhasználók → technikai felhasználó létrehozása",
      },
      {
        key: "nav.password",
        label: "Jelszó",
        kind: "secret",
        envVar: "NAV_PASSWORD",
        help: "A technikai felhasználóhoz te adtad meg. Csak a SHA-512 lenyomata megy ki, a jelszó soha.",
      },
      {
        key: "nav.signKey",
        label: "XML aláírókulcs (signKey)",
        kind: "secret",
        envVar: "NAV_SIGN_KEY",
        help: "A technikai felhasználó létrehozásakor egyszer látható. Ez írja alá a kéréseket.",
      },
      {
        key: "nav.exchangeKey",
        label: "XML cserekulcs (exchangeKey) — opcionális",
        kind: "secret",
        envVar: "NAV_EXCHANGE_KEY",
        help: "A cégadat-lekérdezéshez NEM kell. Csak a későbbi számlaadat-szolgáltatás használja.",
      },
      {
        key: "nav.taxNumber",
        label: "Saját adószám (első 8 jegy)",
        kind: "plain",
        envVar: "NAV_TAX_NUMBER",
        placeholder: "12345678",
        help: "Annak a cégnek az adószáma, amelyhez a technikai felhasználó tartozik.",
      },
      {
        key: "nav.environment",
        label: "Környezet",
        kind: "plain",
        envVar: "NAV_ENV",
        placeholder: "production",
        help: "production vagy test. A teszt rendszer külön regisztráció, külön technikai felhasználóval.",
      },
      {
        key: "nav.softwareId",
        label: "Szoftver azonosító (18 karakter)",
        kind: "plain",
        envVar: "NAV_SOFTWARE_ID",
        placeholder: "18 karakter, saját választás",
        help: "A NAV kötelezően kéri, de nem ő adja ki — te választod. Pontosan 18 karakter.",
      },
    ],
  },
];

export const ALL_FIELDS: IntegrationField[] = INTEGRATION_GROUPS.flatMap((g) => g.fields);

export function fieldByKey(key: string): IntegrationField | undefined {
  return ALL_FIELDS.find((f) => f.key === key);
}

export function isKnownField(key: string): boolean {
  return ALL_FIELDS.some((f) => f.key === key);
}

/**
 * Env-only settings, listed by NAME so the UI can show what exists without
 * ever rendering a value. These are read-only on purpose.
 */
export const INFRASTRUCTURE_VARS: Array<{ name: string; note: string }> = [
  { name: "DATABASE_URL", note: "Database connection — changing it in-app would break the app writing the change" },
  { name: "REDIS_URL", note: "Queue backend" },
  { name: "NEXTAUTH_SECRET", note: "Signs session cookies; rotating it signs everyone out" },
  { name: "CREDENTIALS_KEY", note: "Encrypts everything on this page — must never be editable from it" },
  { name: "APP_URL", note: "Public origin of the app" },
  { name: "PUBLIC_AUDIT_URL", note: "Public audit-report origin" },
  { name: "PUBLIC_QUOTE_URL", note: "Public quote-acceptance origin" },
  { name: "PUBLIC_MEET_URL", note: "Public booking origin" },
  { name: "FILES_DIR", note: "Where generated PDFs and screenshots live" },
  { name: "DB_FLAVOR", note: "postgres | mysql" },
  { name: "MAILGUN_EU", note: "Keeps mail in the EU region (GDPR)" },
];

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

export interface IntegrationProblem {
  key: string;
  message: string;
}

/**
 * The one rule that must hold no matter WHERE a value came from.
 *
 * The boot-time env check (src/lib/env.ts) only sees env. Once domains can also
 * come from the database, that check is no longer sufficient on its own — a
 * workspace could save a cold domain equal to the transactional one and slip
 * past it. So the same invariant is enforced here, on the resolved pair, and
 * this function is called both when saving and when resolving.
 */
export function validateResolved(values: Record<string, string | null>): IntegrationProblem[] {
  const problems: IntegrationProblem[] = [];
  const tx = values["mailgun.tx.domain"]?.trim().toLowerCase() || null;
  const cold = values["mailgun.cold.domain"]?.trim().toLowerCase() || null;

  if (tx && cold && tx === cold) {
    problems.push({
      key: "mailgun.cold.domain",
      message:
        `The cold domain cannot be the same as the transactional domain ("${tx}"). ` +
        "Cold outreach runs on its own domain so a complaint can never burn the " +
        "reputation quotes and contracts depend on.",
    });
  }

  const txKey = values["mailgun.tx.apiKey"];
  const coldKey = values["mailgun.cold.apiKey"];
  if (txKey && coldKey && txKey === coldKey) {
    problems.push({
      key: "mailgun.cold.apiKey",
      message: "The cold sending key must differ from the transactional one.",
    });
  }

  for (const key of ["mailgun.tx.domain", "mailgun.cold.domain"]) {
    const v = values[key]?.trim();
    if (v && !/^(?=.{1,253}$)(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)) {
      problems.push({
        key,
        message: "Enter a bare hostname with no scheme or path, e.g. mg.ventureco.group.",
      });
    }
  }
  return problems;
}

/** Shape check for a single field before it is saved. */
/**
 * NAV field shapes, checked before a value is stored.
 *
 * These are cheap and they matter: a login of the wrong length or a softwareId
 * that is not exactly 18 characters is rejected by NAV with a generic error, and
 * catching it at the point of entry is far kinder than discovering it on the
 * first lookup.
 */
function validateNavField(key: string, value: string): string | null {
  switch (key) {
    case "nav.login":
      return /^[a-zA-Z0-9]{15}$/.test(value)
        ? null
        : "A technikai felhasználó neve pontosan 15 betű/szám.";
    case "nav.taxNumber":
      return /^\d{8}$/.test(value) ? null : "Az adószám első 8 jegye kell ide, kötőjel nélkül.";
    case "nav.environment":
      return value === "production" || value === "test"
        ? null
        : 'Csak "production" vagy "test" lehet.';
    case "nav.softwareId":
      return value.length === 18
        ? null
        : `A szoftver azonosító pontosan 18 karakter (most ${value.length}).`;
    default:
      return null;
  }
}

export function validateField(key: string, value: string): string | null {
  const nav = key.startsWith("nav.") ? validateNavField(key, value) : null;
  if (nav) return nav;

  const field = fieldByKey(key);
  if (!field) return "Unknown setting.";
  const v = value.trim();
  if (!v) return null; // clearing is always allowed — it falls back to env

  if (key === "anthropic.apiKey" && !v.startsWith("sk-ant-")) {
    return "An Anthropic key starts with 'sk-ant-'.";
  }
  if (field.kind === "plain" && /^https?:\/\//i.test(v)) {
    return "Enter a bare hostname, without https://.";
  }
  return null;
}
