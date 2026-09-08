/**
 * Which URLs an Owner may point a webhook at (P5/5.2).
 *
 * ── WHY THIS IS THE MOST IMPORTANT FILE IN THE MODULE ───────────────────────
 *
 * An outbound webhook is a feature that makes the server fetch a URL somebody
 * typed. That is server-side request forgery with a settings panel, and this
 * server sits on a Docker network beside Postgres, Redis and the worker.
 *
 * `http://db:5432`, `http://localhost:3000/api/...` and — the classic —
 * `http://169.254.169.254/`, the cloud metadata endpoint, are all reachable
 * from inside the container and none of them are on the internet. A webhook
 * pointed at one of them turns "notify my CRM" into "read my infrastructure".
 *
 * So the rule is an allowlist of shapes, not a blocklist of hosts:
 *
 *   - https only. Plain http would put the payload — which contains lead names
 *     and contract totals — on the wire in clear text;
 *   - a hostname with a dot in it. Every internal compose service (`db`,
 *     `redis`, `app`, `worker`) is a single label, and so is `localhost`;
 *   - not a bare IP address. Naming a host by IP is how every private range and
 *     the metadata endpoint gets reached, and no legitimate integration needs
 *     it;
 *   - no credentials in the URL, no fragment.
 *
 * DNS still has to be checked at delivery time — a public name can resolve to
 * 127.0.0.1 — and the worker does that. This is the first gate, not the only
 * one.
 */

export type UrlVerdict = { ok: true; url: string } | { ok: false; error: string };

/** Hostnames that are never a customer's system, however they are spelled. */
const BLOCKED_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

/** The compose service names on this installation. */
const INTERNAL_SERVICES = new Set(["app", "db", "redis", "worker", "caddy", "db-mysql"]);

function isIpAddress(host: string): boolean {
  // IPv4, in any of the forms a parser will accept, plus bracketed IPv6.
  if (/^\d+(\.\d+){0,3}$/.test(host)) return true;
  if (/^0[xX][0-9a-fA-F]+$/.test(host)) return true;
  if (host.includes(":")) return true;
  return false;
}

export function validateWebhookUrl(raw: string): UrlVerdict {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Adj meg egy URL-t." };
  if (trimmed.length > 500) return { ok: false, error: "Az URL túl hosszú." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Ez nem érvényes URL." };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      // The payload carries lead names and contract totals.
      error: "Csak https címre küldünk — a payload ügyféladatot tartalmaz.",
    };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Az URL ne tartalmazzon felhasználónevet vagy jelszót." };
  }
  if (parsed.hash) {
    return { ok: false, error: "Az URL ne tartalmazzon # töredéket." };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_NAMES.has(host) || INTERNAL_SERVICES.has(host)) {
    return { ok: false, error: "Ez a gép saját belső címe, nem egy külső rendszer." };
  }
  if (isIpAddress(host)) {
    return {
      ok: false,
      error: "IP-cím helyett tartománynevet adj meg.",
    };
  }
  if (!host.includes(".")) {
    // Every internal service name is a single label, and so is `localhost`.
    return { ok: false, error: "Ez nem néz ki nyilvános tartománynévnek." };
  }
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    return { ok: false, error: "Ez a gép saját belső címe, nem egy külső rendszer." };
  }

  return { ok: true, url: parsed.toString() };
}

/**
 * The delivery-time check, over an address DNS actually resolved to.
 *
 * A perfectly public hostname can have an A record pointing at 127.0.0.1 or
 * 10.0.0.5, and the check above cannot see that — it only reads the string. So
 * the worker resolves the name first and asks this before it connects.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase();

  // IPv6: loopback, link-local, unique-local, and IPv4-mapped forms.
  if (v.includes(":")) {
    if (v === "::1" || v === "::" || v === "::0") return true;
    if (v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd")) return true;
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return false;
  }

  const parts = v.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Unparseable is treated as private: refusing to connect to something we
    // cannot classify is the safe direction.
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local AND cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}
