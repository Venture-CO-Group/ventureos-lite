/**
 * Is this href somewhere in this app?
 *
 * ── WHY IT IS A SHARED FUNCTION ─────────────────────────────────────────────
 *
 * Two features take an href from outside and put it in a link: recents and
 * favourites store one per pin, and the "back to where you came from" control
 * (playbook-v5 P20/4) reads one out of the query string. Both are the same
 * question — "is this a path on this app, or is somebody about to smuggle in a
 * scheme" — and the answer must not differ between them.
 *
 * One leading slash, and nothing that could be read as a protocol-relative URL
 * (`//evil.example`) or a Windows path (`/\evil.example`), both of which
 * browsers will happily treat as another origin.
 */
export function isInternalPath(href: string): boolean {
  return /^\/(?![/\\])/.test(href);
}

/**
 * A return path taken from the URL, or null.
 *
 * Bounded, because it arrives in a query parameter, and refused outright when
 * it is not internal: a "back" button that can be pointed at another origin is
 * an open redirect with a friendly label.
 */
export function returnPath(raw: string | null | undefined, maxLength = 300): string | null {
  if (!raw) return null;
  const value = raw.slice(0, maxLength);
  return isInternalPath(value) ? value : null;
}
