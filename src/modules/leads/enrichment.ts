import { prismaUnsafe } from "@/lib/db";
import { parseRobots, isAllowed, VENTURE_USER_AGENT } from "@/lib/robots";
import { safeFetch, isBlockedHostname } from "@/lib/safe-fetch";
// One implementation of "is this a usable email / phone", shared with the
// extension capture path — two copies would drift.
import { normalizeEmail, normalizePhone } from "@/modules/capture/contact";
import { extractRepresentedBy } from "./impresszum";

/**
 * Company-website enrichment (P1/1c).
 *
 * One fetch of the company's public homepage, cached 30 days, stripped down to
 * readable prose and fed into the research call. The point is to give Claude
 * something real to work with instead of three fields, WITHOUT turning every
 * research run into a crawl: one page, one request, honoured robots.txt, and a
 * cache so a re-run costs nothing.
 */
const CACHE_DAYS = 30;
const CACHE_MS = CACHE_DAYS * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
/** Hard cap on what we keep, well under the prompt's own trim. */
const MAX_TEXT = 4000;

/**
 * Strip a page down to the prose a human would read.
 *
 * Pure and exported so it can be tested without a network. Deliberately
 * simple: no DOM parser, because the input is untrusted HTML from an arbitrary
 * site and the output only ever becomes prompt text — never markup we render.
 */
export function extractReadableText(html: string): string {
  return (html ?? "")
    // Whole regions that are never prose.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Chrome that carries no information about the business.
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, " ")
    // Keep block boundaries as line breaks so sentences do not run together.
    .replace(/<\/(p|div|li|h[1-6]|section|article|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    // Entities we are likely to meet.
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Collapse whitespace, drop the empty lines left behind.
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT);
}

/**
 * Contact details out of a company's own web page.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A Google Places result carries a name, an address, a phone and a website. It
 * carries no email — Places simply does not have one, for any business, ever. So
 * a prospected lead arrived with an empty Email field and stayed that way, and
 * the obvious conclusion ("that is impossible, every company has an email") is
 * right about the company and wrong about the source.
 *
 * The email is on the company's own site, usually in a footer or an impresszum.
 * We are already fetching that page for its copy, already honouring robots.txt,
 * and already caching the result for thirty days — so reading the contacts out of
 * the same response costs nothing extra.
 *
 * READ FROM THE RAW HTML, not from the extracted text: `extractReadableText`
 * strips markup, and `mailto:` / `tel:` links live in the markup. That is why the
 * details were being thrown away by a function that had already downloaded them.
 */
export interface SiteContacts {
  emails: string[];
  phones: string[];
  /**
   * People the impresszum names as representing the company ("Képviseli:
   * Kovács Anna"). Optional: only the outbound contact waterfall reads it.
   */
  names?: string[];
}

/** Addresses no human reads — a site's plumbing, not its contact details. */
const EMAIL_NOISE =
  /^(no-?reply|do-?not-?reply|postmaster|abuse|webmaster|hostmaster|mailer-daemon|bounce)/i;
/** Placeholders that appear in templates and stock footers. */
const EMAIL_PLACEHOLDER =
  /(example\.(com|org|net)|yourdomain|domain\.tld|email@|sentry\.io|wixpress|\.png$|\.jpg$|\.webp$)/i;

export function extractSiteContacts(html: string): SiteContacts {
  const emails = new Set<string>();
  const phones = new Set<string>();

  // mailto: and tel: first — an explicit link is a stated contact detail, where
  // a regex over body text is a guess.
  for (const m of html.matchAll(/href\s*=\s*["']\s*mailto:([^"'?>]+)/gi)) {
    const value = decodeURIComponent(m[1]!.trim());
    if (value) emails.add(value);
  }
  for (const m of html.matchAll(/href\s*=\s*["']\s*tel:([^"'?>]+)/gi)) {
    const value = decodeURIComponent(m[1]!.trim());
    if (value) phones.add(value);
  }

  /**
   * Then plain text, for the sites that print an address without linking it.
   *
   * NOT via `extractReadableText`: that strips <footer>, <header> and <nav> on
   * purpose, because they are chrome rather than prose and the model should not
   * be shown them. But the footer is exactly where a contact address lives — so
   * using it here would throw away the thing we came for. This is the lighter
   * pass: drop the regions that are never text, keep everything else.
   */
  const visible = String(html ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  for (const m of visible.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g)) emails.add(m[0]);

  /** `normalizeEmail`/`normalizePhone` answer with {value, reason}; value is truth. */
  const clean = (list: Set<string>, normalize: (v: string) => string | null): string[] => {
    const out: string[] = [];
    for (const raw of list) {
      const value = normalize(raw);
      if (value && !out.includes(value)) out.push(value);
    }
    return out;
  };

  const names = extractRepresentedBy(visible.replace(/\s+/g, " "));
  return {
    ...(names.length > 0 ? { names } : {}),
    emails: clean(emails, (v) => {
      const local = v.split("@")[0] ?? "";
      // A no-reply address is not a way to reach anybody, and a template
      // placeholder is not an address at all.
      if (EMAIL_NOISE.test(local) || EMAIL_PLACEHOLDER.test(v)) return null;
      return normalizeEmail(v).value;
    }).slice(0, 5),
    phones: clean(phones, (v) => normalizePhone(v).value).slice(0, 5),
  };
}

export type SiteSkipReason =
  | "no_domain"
  | "robots"
  | "unreachable"
  | "empty"
  /** The host is not a public website — see `src/lib/safe-fetch.ts`. */
  | "blocked";

export interface EnrichmentResult {
  /** Contacts read out of the same page, when it was reachable. */
  contacts?: SiteContacts;
  text: string | null;
  /** Why there is no text, when there is none. */
  skipped: SiteSkipReason | null;
  fromCache: boolean;
}

export interface SiteRead {
  text: string | null;
  contacts: SiteContacts;
  skipped: SiteSkipReason | null;
}

const NO_CONTACTS: SiteContacts = { emails: [], phones: [] };

/**
 * Read one public website: robots first, then the homepage, then at most one
 * contact page. Touches no database, so the domain lookup can point it at a
 * hostname the operator has typed but not yet saved, and both callers share one
 * set of crawl manners rather than two.
 */
export async function readSite(raw: string): Promise<SiteRead> {
  let origin: string;
  let path: string;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    origin = u.origin;
    path = u.pathname || "/";
    if (isBlockedHostname(u.hostname)) {
      return { text: null, contacts: NO_CONTACTS, skipped: "blocked" };
    }
  } catch {
    return { text: null, contacts: NO_CONTACTS, skipped: "no_domain" };
  }

  let robotRules: ReturnType<typeof parseRobots> | null = null;
  // robots.txt first. A site that asks us not to read a page does not get read,
  // even though this is a single request on a company we are researching.
  const robotsRes = await safeFetch(`${origin}/robots.txt`, {
    timeoutMs: FETCH_TIMEOUT_MS,
    userAgent: VENTURE_USER_AGENT,
  });
  if (robotsRes?.ok) {
    // Kept, so the contact-page attempt below is judged by the same rules
    // rather than re-fetching robots.txt or quietly ignoring it.
    robotRules = parseRobots(await robotsRes.text(), VENTURE_USER_AGENT);
    if (!isAllowed(robotRules, path)) {
      return { text: null, contacts: NO_CONTACTS, skipped: "robots" };
    }
  }
  // A missing or erroring robots.txt means no restrictions.

  let text: string | null = null;
  let contacts: SiteContacts = NO_CONTACTS;
  const res = await safeFetch(`${origin}${path}`, {
    timeoutMs: FETCH_TIMEOUT_MS,
    userAgent: VENTURE_USER_AGENT,
    accept: "text/html",
  });
  if (!res) return { text: null, contacts: NO_CONTACTS, skipped: "unreachable" };
  if (res.ok && (res.headers.get("content-type") ?? "").includes("text/html")) {
    const html = await res.text();
    text = extractReadableText(html) || null;
    // From the RAW html: mailto:/tel: live in the markup that the text
    // extraction above strips out.
    contacts = extractSiteContacts(html);
  }

  /**
   * ONE MORE PAGE, and only when the homepage gave us no address.
   *
   * Hungarian sites overwhelmingly put contact details on /kapcsolat or
   * /impresszum rather than on the front page — the impresszum is a legal
   * requirement, so it is the most reliable place an email exists at all. Reading
   * only the homepage therefore left the Email field blank on a large share of
   * exactly the prospected leads this is meant to serve.
   *
   * Deliberately bounded: at most ONE extra request, skipped entirely when the
   * homepage already yielded an address, each candidate checked against the same
   * robots rules, and the first hit wins. That is a second page on a company we
   * are actively researching, once every thirty days — not a crawl.
   */
  if (contacts.emails.length === 0) {
    const found = await fetchContactPage(origin, robotRules);
    if (found) {
      contacts = {
        ...(found.names || contacts.names ? { names: [...(contacts.names ?? []), ...(found.names ?? [])] } : {}),
        emails: found.emails,
        // Keep a homepage phone if we already had one; it is likelier to be the
        // main line than a number buried in an impresszum.
        phones: contacts.phones.length > 0 ? contacts.phones : found.phones,
      };
    }
  }

  return { text, contacts, skipped: text ? null : "empty" };
}

/**
 * Fetch and cache the homepage text for a company. Never throws: enrichment is
 * a bonus, and a site being down must not fail a research run.
 */
export async function enrichCompanySite(companyId: string): Promise<EnrichmentResult> {
  const company = await prismaUnsafe.company.findUnique({
    where: { id: companyId },
    select: { id: true, domain: true, website: true, siteText: true, siteFetchedAt: true },
  });
  if (!company) return { text: null, skipped: "no_domain", fromCache: false };

  const fresh =
    company.siteFetchedAt && Date.now() - company.siteFetchedAt.getTime() < CACHE_MS;
  if (fresh) {
    return { text: company.siteText, skipped: company.siteText ? null : "empty", fromCache: true };
  }

  const raw = company.website ?? company.domain;
  if (!raw) return { text: null, skipped: "no_domain", fromCache: false };

  const read = await readSite(raw);
  if (read.skipped === "no_domain") {
    return { text: null, skipped: "no_domain", fromCache: false };
  }
  // Record the attempt either way — including a refusal — so a dead or
  // unreachable site is not refetched on every research run.
  await stampFetch(company.id, read.text);
  return {
    text: read.text,
    skipped: read.skipped,
    fromCache: false,
    contacts: read.contacts,
  };
}

/** Paths that carry contact details, commonest first. */
const CONTACT_PATHS = [
  "/kapcsolat",
  "/impresszum",
  "/contact",
  "/kapcsolatok",
  "/elerhetoseg",
  "/about",
];

/**
 * Try the contact pages in order and return the first that yields an address.
 *
 * Stops at the first hit, and at the first path robots allows but that answers
 * with anything other than HTML. Every failure is silent: this is a best-effort
 * extra on top of a result we already have.
 */
async function fetchContactPage(
  origin: string,
  rules: ReturnType<typeof parseRobots> | null,
): Promise<SiteContacts | null> {
  for (const path of CONTACT_PATHS) {
    if (rules && !isAllowed(rules, path)) continue;
    // Unreachable, timed out, or refused — safeFetch answers null, try the next.
    const res = await safeFetch(`${origin}${path}`, {
      timeoutMs: FETCH_TIMEOUT_MS,
      userAgent: VENTURE_USER_AGENT,
      accept: "text/html",
    });
    if (!res?.ok) continue;
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) continue;
    const found = extractSiteContacts(await res.text());
    if (found.emails.length > 0) return found;
  }
  return null;
}

/** Record the attempt either way, so a dead site is not refetched every run. */
async function stampFetch(companyId: string, text: string | null): Promise<void> {
  await prismaUnsafe.company.update({
    where: { id: companyId },
    data: { siteText: text, siteFetchedAt: new Date() },
  });
}
