/**
 * Capped same-site crawl for the audit worker (P2/1).
 *
 * Plain HTTP, not Playwright: the crawl needs titles, links and status codes
 * from up to 25 pages, and rendering each one in a browser would cost minutes
 * for information that is in the markup. The homepage and the two heaviest
 * pages get the browser treatment separately (probePagesDeep).
 *
 * We are a guest on someone else's server, so: robots.txt is obeyed, the user
 * agent names us, requests start no more often than once a second (or slower
 * when robots asks), and the whole thing gives up on a deadline rather than
 * running long on a slow host.
 *
 * The parsing helpers are exported and pure so the frontier logic is testable
 * without a network.
 */
import { parseRobots, isAllowed, VENTURE_USER_AGENT } from "@/lib/robots";
import type { BrokenLink, CrawlPage, CrawlResult } from "./types";

export const DEFAULT_CRAWL_CAP = 15;
export const MAX_CRAWL_CAP = 25;

/** Minimum gap between the STARTS of two requests to the same host. */
const MIN_INTERVAL_MS = 1000;
/** In-flight requests. The pacer, not this, sets the actual rate. */
const CONCURRENCY = 4;
const PAGE_TIMEOUT_MS = 10_000;
/** How many linked-but-unvisited URLs we verify with a HEAD request. */
const LINK_CHECK_CAP = 20;
/**
 * Whole-crawl budget.
 *
 * The target is a ≤90s audit at cap 15, and the stages add up: this crawl
 * (≤45s), the two deep probes (≤10s each), the homepage probe and the
 * screenshots (~25s together on a slow site). Paced at one request a second,
 * 45s buys 15 pages plus most of the link checks; past that the crawl returns
 * what it has and says it stopped early rather than overrunning the budget.
 */
const DEADLINE_MS = 45_000;
/** Enough to find every link and title; a page bigger than this is pathological. */
const MAX_HTML_BYTES = 2_000_000;
const MAX_SITEMAP_URLS = 500;

/** Extensions we never open as pages — they are not HTML. */
const NON_PAGE = /\.(pdf|zip|rar|7z|docx?|xlsx?|pptx?|csv|jpe?g|png|gif|webp|avif|svg|ico|mp[34]|mov|avi|woff2?|ttf|eot|css|js|json|xml|rss|atom)($|\?)/i;

/**
 * A page fetched by a real browser (P2/9).
 *
 * Injected rather than imported, so this module stays free of Playwright and
 * can keep being imported by the web bundle. The worker supplies the
 * implementation; a static crawl passes nothing and behaves exactly as before.
 */
export interface RenderedPage {
  html: string;
  status: number | null;
  finalUrl: string;
  /** Links discovered in the RENDERED DOM, which is where a SPA's nav lives. */
  links: string[];
}

export type RenderPage = (url: string) => Promise<RenderedPage>;

export interface CrawlOptions {
  cap?: number;
  /** When set, pages are rendered in a browser instead of merely fetched. */
  renderPage?: RenderPage;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so a fake crawl does not sleep for real seconds. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Hostname without www, lowercased. Null when the URL is unusable. */
export function siteHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

export function sameSite(a: string, b: string): boolean {
  const ha = siteHost(a);
  const hb = siteHost(b);
  return ha !== null && ha === hb;
}

/**
 * Absolute, fragment-free URL, or null when it is not a same-site page we
 * could open (mailto:, tel:, another domain, a PDF).
 */
export function normalizeCrawlUrl(href: string, base: string): string | null {
  const raw = (href ?? "").trim();
  if (!raw || raw.startsWith("#")) return null;
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!sameSite(u.toString(), base)) return null;
  u.hash = "";
  return u.toString();
}

function hrefsIn(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function regions(html: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let joined = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) joined += m[1] ?? "";
  return joined;
}

/**
 * Links grouped by where they came from.
 *
 * Nav and footer first because that is the site's own idea of what matters —
 * when the cap bites, we want the pages the owner put in the menu, not the
 * fourth blog post from 2019.
 */
export function extractLinks(
  html: string,
  base: string,
): { nav: string[]; footer: string[]; body: string[] } {
  const pick = (chunk: string) =>
    hrefsIn(chunk)
      .map((h) => normalizeCrawlUrl(h, base))
      .filter((u): u is string => u !== null);

  const nav = pick(regions(html, "nav"));
  const footer = pick(regions(html, "footer"));
  const body = pick(html);
  return { nav, footer, body };
}

export function parseSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && out.length < MAX_SITEMAP_URLS) {
    out.push(m[1]!);
  }
  return out;
}

/**
 * Crawl order: the menu, then the footer, then the sitemap, then everything
 * else — deduplicated, HTML only, start URL removed.
 */
export function planFrontier(
  sources: { nav: string[]; footer: string[]; sitemap: string[]; body: string[] },
  startUrl: string,
): string[] {
  const seen = new Set<string>([startUrl]);
  const out: string[] = [];
  for (const url of [...sources.nav, ...sources.footer, ...sources.sitemap, ...sources.body]) {
    if (seen.has(url) || NON_PAGE.test(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Title, meta description and H1 count, without a DOM parser. */
export function parseDocumentMeta(html: string): {
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
} {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? null;
  const metaTag =
    /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i.exec(html)?.[0] ?? null;
  const metaDescription = metaTag
    ? (/\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(metaTag)?.[2] ??
       /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(metaTag)?.[3] ??
       null)
    : null;
  const h1Count = (html.match(/<h1\b/gi) ?? []).length;

  const clean = (v: string | null) => {
    if (v === null) return null;
    const t = v.replace(/\s+/g, " ").trim();
    return t.length === 0 ? null : t;
  };
  return { title: clean(title), metaDescription: clean(metaDescription), h1Count };
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

/**
 * One request start per interval, shared by every worker.
 *
 * Concurrency overlaps the WAITING (a slow page does not stall the others),
 * while the pacer keeps the rate we promised the site owner.
 */
export class Pacer {
  private next = 0;
  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async take(): Promise<void> {
    const t = this.now();
    const at = Math.max(t, this.next);
    this.next = at + this.intervalMs;
    if (at > t) await this.sleep(at - t);
  }
}

// ---------------------------------------------------------------------------
// The crawl
// ---------------------------------------------------------------------------

interface Fetched {
  status: number | null;
  finalUrl: string;
  redirects: string[];
  body: string;
  bytes: number;
}

/**
 * Follow redirects by hand so the chain is visible. `redirect: "follow"` hides
 * it, and "your menu link goes through three hops" is exactly the finding.
 */
async function fetchPage(
  url: string,
  doFetch: typeof fetch,
  method: "GET" | "HEAD",
): Promise<Fetched> {
  const redirects: string[] = [];
  let current = url;
  for (let hop = 0; hop < 6; hop += 1) {
    const res = await doFetch(current, {
      method,
      redirect: "manual",
      headers: { "user-agent": VENTURE_USER_AGENT, accept: "text/html,*/*" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      redirects.push(current);
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        break;
      }
      // Off-site redirects end the chain: we do not crawl other people's sites.
      if (!sameSite(next, url)) {
        return { status: res.status, finalUrl: next, redirects, body: "", bytes: 0 };
      }
      current = next;
      continue;
    }

    const type = res.headers.get("content-type") ?? "";
    let body = "";
    let bytes = 0;
    if (method === "GET" && res.ok && type.includes("html")) {
      const text = await res.text();
      bytes = Buffer.byteLength(text);
      body = text.slice(0, MAX_HTML_BYTES);
    }
    return { status: res.status, finalUrl: current, redirects, body, bytes };
  }
  return { status: null, finalUrl: current, redirects, body: "", bytes: 0 };
}

/**
 * Crawl up to `cap` same-site pages starting at `startUrl`.
 *
 * Never throws: a crawl that dies halfway is still worth reporting, and the
 * audit around it must not fail because one page timed out.
 */
export async function crawlSite(
  startUrl: string,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cap = Math.min(Math.max(1, options.cap ?? DEFAULT_CRAWL_CAP), MAX_CRAWL_CAP);
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  const started = now();
  const expired = () => now() - started > deadlineMs;

  // robots.txt first: it decides both what we may open and how fast.
  let rules = { allow: [] as string[], disallow: [] as string[], crawlDelay: null as number | null };
  try {
    const res = await doFetch(new URL("/robots.txt", startUrl).toString(), {
      headers: { "user-agent": VENTURE_USER_AGENT },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (res.ok) rules = parseRobots(await res.text(), VENTURE_USER_AGENT);
  } catch {
    // No robots.txt is permission, and an unreachable one is not our call to
    // interpret — either way we fall back to our own conservative rate.
  }
  const interval = Math.max(MIN_INTERVAL_MS, (rules.crawlDelay ?? 0) * 1000);
  const pacer = new Pacer(interval, now, sleep);

  const permitted = (url: string): boolean => {
    try {
      const u = new URL(url);
      return isAllowed(rules, `${u.pathname}${u.search}`);
    } catch {
      return false;
    }
  };

  let sitemapUrls: string[] = [];
  try {
    await pacer.take();
    const res = await doFetch(new URL("/sitemap.xml", startUrl).toString(), {
      headers: { "user-agent": VENTURE_USER_AGENT },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (res.ok) {
      sitemapUrls = parseSitemapLocs(await res.text()).filter((u) => sameSite(u, startUrl));
    }
  } catch {
    /* a sitemap is a bonus, not a requirement */
  }

  const pages: CrawlPage[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];
  const queued = new Set<string>();
  let robotsSkipped = 0;
  let deadlineHit = false;

  const enqueue = (urls: string[]) => {
    for (const u of urls) {
      if (queued.has(u) || visited.has(u)) continue;
      if (!permitted(u)) {
        robotsSkipped += 1;
        continue;
      }
      queued.add(u);
      queue.push(u);
    }
  };

  const visit = async (url: string): Promise<void> => {
    visited.add(url);
    try {
      await pacer.take();
      if (expired()) {
        deadlineHit = true;
        return;
      }
      // In rendered mode the browser IS the fetch: asking twice would double
      // both the load on their server and our own runtime.
      const r = options.renderPage
        ? await (async () => {
            const rp = await options.renderPage!(url);
            return {
              status: rp.status,
              finalUrl: rp.finalUrl,
              redirects: [] as string[],
              body: rp.html,
              bytes: Buffer.byteLength(rp.html),
              renderedLinks: rp.links,
            };
          })()
        : { ...(await fetchPage(url, doFetch, "GET")), renderedLinks: undefined as string[] | undefined };
      const meta = parseDocumentMeta(r.body);
      const found = r.body ? extractLinks(r.body, r.finalUrl) : { nav: [], footer: [], body: [] };
      // A client-side router's links exist only after hydration, so they are
      // merged in rather than replacing what the markup already offered.
      if (r.renderedLinks?.length) {
        found.nav = [...new Set([...found.nav, ...r.renderedLinks])];
      }
      // Every same-site target is kept for the broken-link check — a dead PDF
      // in the footer is as broken as a dead page. Only the crawlable subset
      // joins the frontier.
      const links = [...new Set([...found.nav, ...found.footer, ...found.body])].filter(
        (u) => u !== url,
      );
      const frontier = planFrontier(
        { nav: found.nav, footer: found.footer, sitemap: [], body: found.body },
        url,
      );
      pages.push({
        url,
        finalUrl: r.finalUrl,
        status: r.status,
        redirects: r.redirects,
        title: meta.title,
        metaDescription: meta.metaDescription,
        h1Count: meta.h1Count,
        bytes: r.bytes,
        links,
      });
      enqueue(frontier);
    } catch {
      pages.push({
        url,
        finalUrl: url,
        status: null,
        redirects: [],
        title: null,
        metaDescription: null,
        h1Count: 0,
        bytes: 0,
        links: [],
      });
    }
  };

  // The homepage seeds the frontier; the sitemap joins it after, so the site's
  // own navigation still wins the first slots.
  if (!permitted(startUrl)) {
    return {
      startUrl,
      pages: [],
      brokenLinks: [],
      sitemapUrls,
      cap,
      discovered: 0,
      robotsSkipped: 1,
      linkCheckTruncated: false,
      deadlineHit: false,
      elapsedMs: now() - started,
      mode: options.renderPage ? "rendered" : "static",
    };
  }
  await visit(startUrl);
  enqueue(sitemapUrls.filter((u) => !NON_PAGE.test(u)));

  // Concurrency overlaps slow responses; the pacer still gates the rate.
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      if (visited.size >= cap || queue.length === 0) return;
      if (expired()) {
        deadlineHit = true;
        return;
      }
      const next = queue.shift();
      if (next === undefined) return;
      await visit(next);
    }
  });
  await Promise.all(workers);

  // ---- broken links -------------------------------------------------------
  // Pages we opened report their own status. Everything else linked from them
  // gets a HEAD, up to the budget — an unbounded check on a site with 400
  // links would be the whole runtime.
  const brokenLinks: BrokenLink[] = [];
  const statusByUrl = new Map<string, number | null>();
  for (const p of pages) statusByUrl.set(p.url, p.status);

  for (const p of pages) {
    for (const target of p.links) {
      const known = statusByUrl.get(target);
      if (known !== undefined && known !== null && known >= 400) {
        brokenLinks.push({ from: p.url, to: target, status: known });
      }
    }
  }

  const unchecked: Array<{ from: string; to: string }> = [];
  const seenTargets = new Set(statusByUrl.keys());
  for (const p of pages) {
    for (const target of p.links) {
      if (seenTargets.has(target)) continue;
      seenTargets.add(target);
      if (!permitted(target)) continue;
      unchecked.push({ from: p.url, to: target });
    }
  }
  const linkCheckTruncated = unchecked.length > LINK_CHECK_CAP;
  for (const { from, to } of unchecked.slice(0, LINK_CHECK_CAP)) {
    if (expired()) {
      deadlineHit = true;
      break;
    }
    try {
      await pacer.take();
      const r = await fetchPage(to, doFetch, "HEAD");
      if (r.status !== null && r.status >= 400) {
        brokenLinks.push({ from, to, status: r.status });
      }
    } catch {
      // A HEAD that throws is inconclusive — some servers refuse HEAD
      // outright — so it is not reported as broken.
    }
  }

  return {
    startUrl,
    pages,
    brokenLinks,
    sitemapUrls,
    cap,
    discovered: queued.size + 1,
    robotsSkipped,
    linkCheckTruncated,
    deadlineHit,
    elapsedMs: now() - started,
    // Derived rather than passed in: a renderer having been supplied IS the
    // mode, so the two cannot disagree.
    mode: options.renderPage ? "rendered" : "static",
  };
}
