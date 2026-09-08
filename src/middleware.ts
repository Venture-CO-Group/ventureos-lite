import { NextResponse, type NextRequest } from "next/server";

/**
 * Two jobs, in order: route the public surfaces, then gate everything else
 * behind a session.
 *
 * PUBLIC SURFACES (CLAUDE.md → Domain layout). The authenticated app is the
 * ROOT of ventureco.agency. Three prospect-facing surfaces are served by the
 * same Next app on their own subdomains:
 *
 *   audit.<domain>/<slug>  →  /share/<slug>    public website-audit report
 *   quote.<domain>/<slug>  →  /accept/<slug>   public quote acceptance
 *   meet.<domain>/<slug>   →  /book/<slug>     public booking page
 *
 * The authoritative, env-driven mapping lives in the Caddyfile, which knows the
 * real hostnames and marks each request with `X-Public-Surface`. Middleware
 * runs in the edge runtime, where `process.env` is inlined at BUILD time — so
 * it must not read hostnames from env itself. It honours Caddy's header and
 * falls back to the structural subdomain prefix, which needs no configuration
 * and works in local dev too.
 *
 * AUTH GATE. This is a cheap presence check on the session cookie so signed-out
 * visitors get a clean redirect instead of an error page. It is NOT the
 * security boundary: the cookie is signed by Auth.js and the token inside it is
 * resolved against the `sessions` table by `getActiveContext()` on every server
 * action and page. Forging a cookie gets you a redirect loop, not access.
 */
const SURFACES = {
  audit: "/share",
  quote: "/accept",
  meet: "/book",
} as const;

type Surface = keyof typeof SURFACES;

/** Paths that must stay reachable without a session. */
const PUBLIC_PREFIXES = [
  "/login",
  "/reset", // one-time password reset links (the token is the credential)
  /**
   * Invitation acceptance (§2).
   *
   * Public by necessity: this is somebody's first contact with the product and
   * they have no session to gate on. The token is the credential, on exactly
   * the same terms as `/reset` — 256 bits, hashed at rest, single-use, seven
   * days — and the page tells a revoked link nothing a link nobody issued
   * would not also be told.
   */
  "/invite",
  "/api/auth", // Auth.js endpoints
  "/api/health", // container + proxy probes
  "/api/cold/unsubscribe", // one-click unsubscribe in cold mail
  "/api/mailgun", // inbound mail routes (signature-verified)
  "/api/webhooks", // delivery/bounce webhooks (signature-verified)
  "/api/capture", // browser-extension capture (bearer token, not a session)
  "/share", // public audit reports (legacy path, still served)
  "/api/share", // screenshots for a public report (slug is the capability)
  // A workspace logo, on every prospect-facing surface. Public by nature — a
  // logo is the most published thing a company owns (audit-v2 item 6).
  "/api/brand-logo",
  "/r", // public audit reports on the audit domain
  "/public-audit", // self-serve audit landing
  "/accept", // public quote acceptance
  "/book", // public booking pages
  "/manifest.webmanifest",
  // The icon set. Every one of these has to answer without a session: a browser
  // fetches the favicon while showing the LOGIN page, and an install prompt
  // reads the manifest's icons before anyone has signed in. A redirect to
  // /login in place of a PNG is how a PWA ends up installing with a blank tile.
  "/favicon.svg",
  "/favicon.ico",
  "/mask-icon.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-192-maskable.png",
  "/icon-512-maskable.png",
  // Fetched by whatever is unfurling a link — a chat client, never a session.
  "/og-image.png",
  "/sw.js",
  /**
   * The signal layer (v3 P8/a). Both of these are requested BY a prospect
   * reading a quote or an audit report, who by definition has no session — and
   * the e2e suite could not have caught it, because it runs signed in.
   */
  "/t.js", // the measurement script
  "/api/t", // its beacon endpoint
  /**
   * Open pixel and click redirect (v3 P9/1). Requested BY the recipient's mail
   * client, which has no session and never will — the same trap /t.js fell
   * into, and the browser suite cannot see it because it runs signed in.
   */
  "/api/e",
  "/privacy", // the notice on every tracked page links here
  "/reports", // published sector reports (v4 P12/2c) — read by anyone
];

function detectSurface(req: NextRequest): Surface | null {
  const marked = req.headers.get("x-public-surface")?.trim().toLowerCase();
  if (marked === "audit" || marked === "quote" || marked === "meet") return marked;

  const host = (req.headers.get("host") ?? "").split(":")[0].toLowerCase();
  for (const key of Object.keys(SURFACES) as Surface[]) {
    if (host.startsWith(`${key}.`)) return key;
  }
  return null;
}

/**
 * Auth.js names its cookie `authjs.session-token`, prefixed with `__Secure-`
 * when served over https. Match either rather than hardcoding one.
 */
function hasSessionCookie(req: NextRequest): boolean {
  return req.cookies
    .getAll()
    .some((c) => /^(__Secure-)?authjs\.session-token(\.\d+)?$/.test(c.name) && !!c.value);
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const surface = detectSurface(req);

  // ---- public surfaces: rewrite a bare slug onto its app route -------------
  if (surface) {
    const target = SURFACES[surface];

    // The audit domain root is the self-serve landing page (P12/1a), not the
    // app. Everything else on that host is a report.
    if (surface === "audit" && pathname === "/") {
      const url = req.nextUrl.clone();
      url.pathname = "/public-audit";
      return NextResponse.rewrite(url);
    }

    // /hu and /en on the audit host are the landing in that language. Matched
    // BEFORE the bare-slug fallback below, so a report slug can never shadow a
    // language — and kept to an exact match, since a two-letter slug is
    // theoretically possible even if 9 random bytes make it vanishingly rare.
    if (surface === "audit" && (pathname === "/hu" || pathname === "/en")) {
      const url = req.nextUrl.clone();
      url.pathname = `/public-audit${pathname}`;
      return NextResponse.rewrite(url);
    }

    if (
      pathname === "/" ||
      pathname.startsWith(target) ||
      pathname.startsWith("/public-audit") ||
      pathname.startsWith("/r/") ||
      // The measurement notice on a report or a quote links here, and the
      // reader is on the public host — without this the bare-slug fallback
      // below would redirect /privacy to /r/privacy and 404 the disclosure.
      pathname === "/privacy" ||
      // Published reports live on the audit host as a real section, not a slug.
      pathname === "/reports" ||
      pathname.startsWith("/reports/") ||
      pathname.startsWith("/api") ||
      pathname.startsWith("/_next") ||
      pathname.includes(".")
    ) {
      return NextResponse.next();
    }
    // Only the bare first segment is a slug; anything deeper is not a public page.
    if (pathname.slice(1).includes("/")) return NextResponse.next();

    // Audit reports moved under /r/ when the root became the landing page.
    // Links already in prospects' inboxes are bare slugs, so redirect them
    // permanently rather than breaking them.
    if (surface === "audit") {
      const url = req.nextUrl.clone();
      url.pathname = `/r${pathname}`;
      return NextResponse.redirect(url, 301);
    }

    const url = req.nextUrl.clone();
    url.pathname = `${target}${pathname}`;
    return NextResponse.rewrite(url);
  }

  // ---- app origin: require a session --------------------------------------
  if (
    pathname.startsWith("/_next") ||
    PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return NextResponse.next();
  }

  if (!hasSessionCookie(req)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Preserve where they were heading, so login lands them there.
    if (pathname !== "/") url.searchParams.set("next", pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
