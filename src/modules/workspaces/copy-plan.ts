/**
 * What "copy the settings from an existing workspace" means (P6/6.1).
 *
 * ── WHY A DECLARED PLAN AND NOT A LOOP OVER TABLES ──────────────────────────
 *
 * `provisionWorkspace` gives a new workspace the DEFAULTS: the stock pipelines,
 * the base document templates, the standard targets, a score gate of 3. That is
 * the right floor and the wrong ceiling — an agency that has spent a year
 * tuning its quote rules, its custom fields and its letterhead does not want to
 * do it again for the second company it runs.
 *
 * The dangerous version of this feature is "copy the workspace". A workspace
 * contains leads, documents, invoices, audit logs and other people's personal
 * data; copying any of it across a tenancy boundary is precisely what the whole
 * guard exists to prevent. So the plan is a CLOSED LIST of settings, written
 * down here with its exclusions, and the copy function may only touch what this
 * file names.
 *
 * A plain module: pure data and pure predicates, so a test can assert the list
 * without a database, and so the exclusions cannot be quietly widened.
 */

export interface CopyGroup {
  key: string;
  label: string;
  /** Shown next to the checkbox — what the group actually contains. */
  hint: string;
}

/**
 * The groups an Owner can choose from.
 *
 * Every one of these is CONFIGURATION: a decision somebody made about how the
 * software should behave. None of it is a record about a person.
 */
export const COPY_GROUPS: readonly CopyGroup[] = [
  {
    key: "brand",
    label: "Márka és fejléc",
    hint: "Szín, logó, jogi név — a dokumentumok fejléce.",
  },
  {
    key: "fields",
    label: "Egyedi mezők",
    hint: "A lead/cég/deal saját mezői, opciókkal és sorrenddel. Értékek nélkül.",
  },
  {
    key: "pipelines",
    label: "Pipeline-ok és stádiumok",
    hint: "A deal-tábla oszlopai és a nyert/vesztett jelölésük. Deal-ek nélkül.",
  },
  {
    key: "documentTemplates",
    label: "Dokumentum-sablonok",
    hint: "Ajánlat, szerződés, teljesítési igazolás — a szövegek maguk.",
  },
  {
    key: "projectTemplates",
    label: "Projekt-sablonok",
    hint: "A szállítási mérföldkő-listák.",
  },
  {
    key: "workflows",
    label: "Workflow szabályok",
    hint: "A szabályok maguk, kikapcsolva. A lefutási naplók nélkül.",
  },
  {
    key: "quoteRules",
    label: "Ajánlat-szabályok",
    hint: "Érvényesség, engedmény-korlát, a viselkedési szabályok.",
  },
  {
    key: "scoring",
    label: "Pontozás és kapuk",
    hint: "Az ICP kritériumok, a kapu-küszöb, és az audit súlyozás.",
  },
  {
    key: "targets",
    label: "Célszámok",
    hint: "A dashboard heti és havi céljai.",
  },
  {
    key: "navigation",
    label: "Elrejtett menüpontok",
    hint: "Amit ebben a munkaterületben nem használunk.",
  },
] as const;

export const COPY_GROUP_KEYS: readonly string[] = COPY_GROUPS.map((g) => g.key);

/**
 * What is NEVER copied, and why — kept as data so a test can hold the line.
 *
 * This list is the feature's safety argument. If somebody later adds "copy
 * everything", the test over this constant is what tells them what they broke.
 */
export const NEVER_COPIED: readonly { what: string; why: string }[] = [
  { what: "leads", why: "Személyes adat. Egy másik cég ügyfele nem ennek a cégnek az ügyfele." },
  { what: "companies", why: "Ugyanaz — és a duplikáció-szűrés munkaterületen belül működik." },
  { what: "documents", why: "Ajánlatok és szerződések. Egy másolt szerződés jogi hiba." },
  { what: "invoices", why: "Számla. Egy másolt számlaszám könyvelési hiba." },
  { what: "auditLogs", why: "A napló arról szól, ki mit tett — nem hordozható." },
  { what: "members", why: "A hozzáférést az Owner adja meg, nem egy másolás." },
  { what: "apiKeys", why: "Mailgun, Számlázz.hu, Anthropic — külön fiók, külön kulcs." },
  { what: "webhooks", why: "Egy webhook egy konkrét külső rendszerre mutat, titokkal." },
  { what: "claudeBudget", why: "Költési korlát. Munkaterületenként külön döntés." },
  { what: "savedViews", why: "Személyes nézetek, és lead-szűrőkre hivatkoznak." },
];

export function sanitizeGroups(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const wanted = raw.filter((v): v is string => typeof v === "string");
  // Declared order, deduplicated. The copy runs in this order too, so a
  // template's stages exist before anything that could reference them.
  return COPY_GROUP_KEYS.filter((k) => wanted.includes(k));
}

export function describeCopy(counts: Record<string, number>): string {
  const parts = COPY_GROUPS.filter((g) => (counts[g.key] ?? 0) > 0).map(
    (g) => `${g.label.toLowerCase()}: ${counts[g.key]}`,
  );
  return parts.length > 0 ? parts.join(" · ") : "semmi";
}
