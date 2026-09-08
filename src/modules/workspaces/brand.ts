/**
 * Workspace branding (P2/6).
 *
 * Every audit output — the internal header, the sales PDF, the public share
 * page, the self-serve teaser and the emailed report — used to carry "venture
 * co.group" written into the markup. That is fine for one company and wrong for
 * a product: the second workspace would have sent a prospect a report signed by
 * someone else's agency.
 *
 * All of it now comes from here. Venture remains the SEED, so an untouched
 * workspace renders exactly as before, and the "venture" wordmark is only ever
 * a default value rather than a constant in a template.
 *
 * Pure over Workspace.brand, so a rendered artefact can be tested against a
 * second brand without a database.
 */
export interface WorkspaceBrand {
  /** Display name, e.g. "Venture CO Group". */
  name: string;
  /** The name that goes on a contract. Falls back to the display name. */
  legalName: string;
  /** The two halves of the wordmark: bold, then light. */
  markBold: string;
  markLight: string;
  /** Public URL the logo is served from. When set, it replaces the wordmark. */
  logoUrl: string | null;
  /**
   * Where the uploaded file actually lives under FILES_DIR. Kept apart from
   * `logoUrl` because the URL is public and cache-busted while the path is
   * internal — and because a logo has to be readable WITHOUT a session: it
   * appears on prospect-facing pages.
   */
  logoPath: string | null;
  /** Primary accent and the gradient it sits in. */
  color: string;
  gradientFrom: string;
  gradientTo: string;
  /** Surface colours. These ARE the design tokens for the seed workspace. */
  canvas: string;
  ink: string;
  muted: string;
  /** Family names only — the stacks are built by `brandFontStack`. */
  fontDisplay: string;
  fontBody: string;
  /** The legal line at the foot of a public page or PDF. */
  footerIdentity: string;
  /** Structured footer parts, appended to the identity line when present. */
  footerAddress: string | null;
  footerRegistration: string | null;
  footerContact: string | null;
  /** Who a report appears to come from. */
  senderName: string;
  senderEmail: string | null;
  /** Path prefix for this workspace's public links, e.g. "r". */
  slugPrefix: string;
  /**
   * Bare host this workspace's public links are built on, e.g.
   * "audit.studio.hu". Null means "use the deployment's own public surface".
   */
  publicHost: string | null;
}

/**
 * Bumped whenever the SHAPE of the brand changes in a way that would alter a
 * rendered artefact. Documents store the version they were generated under so
 * an old PDF can be re-rendered exactly as it was (see `documents/brand-snapshot.ts`).
 */
export const BRAND_VERSION = 1;

/**
 * The seed, and the reason this change is invisible to the Venture workspace.
 *
 * Every colour here is the corresponding token from tailwind.config.ts, and the
 * fonts are the two from the design system. An unconfigured workspace resolves
 * to exactly this, so every surface renders byte-for-byte as it did before the
 * brand became configurable. A unit test pins each value against the tokens.
 */
export const VENTURE_BRAND: WorkspaceBrand = {
  name: "Venture CO Group",
  legalName: "Venture CO Group",
  markBold: "venture",
  markLight: "co.group",
  logoUrl: null,
  logoPath: null,
  color: "#7427C6",
  gradientFrom: "#310B59",
  gradientTo: "#7427C6",
  canvas: "#00051D",
  ink: "#EFF1F8",
  muted: "#858CAE",
  fontDisplay: "Bricolage Grotesque",
  fontBody: "Inter",
  footerIdentity: "Venture CO Group · Budapest",
  footerAddress: null,
  footerRegistration: null,
  footerContact: null,
  senderName: "Venture CO Group",
  senderEmail: null,
  slugPrefix: "r",
  publicHost: null,
};

const HEX = /^#[0-9a-fA-F]{3,8}$/;

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function color(v: unknown, fallback: string): string {
  return typeof v === "string" && HEX.test(v.trim()) ? v.trim() : fallback;
}

/**
 * A hex colour, and nothing else.
 *
 * Exported because the letterhead is no longer the only place a user-chosen
 * colour reaches a `style` attribute — a task board's accent does too, and a
 * second regex written slightly differently is a second thing to get wrong.
 */
export function isSafeColor(v: unknown): v is string {
  return typeof v === "string" && HEX.test(v.trim());
}

/** A bare hostname — no scheme, no port, no path. */
const BARE_HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * A font family name, stripped of anything that could escape the CSS
 * declaration it is interpolated into. Family names reach a `style` attribute
 * in the PDF templates, so a quote or a brace there is a way out of it.
 */
function fontName(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const clean = v.replace(/[^a-zA-Z0-9 \-]/g, "").trim().slice(0, 48);
  return clean || fallback;
}

function host(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim().toLowerCase();
  return BARE_HOST.test(trimmed) ? trimmed : null;
}

function optional(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
}

/**
 * Read a workspace's brand, falling back per FIELD.
 *
 * Per field rather than per object on purpose: a workspace that set only a
 * colour should not lose the rest of a usable identity, and a half-configured
 * brand must still render something coherent.
 */
export function brandFrom(raw: unknown): WorkspaceBrand {
  if (!raw || typeof raw !== "object") return VENTURE_BRAND;
  const b = raw as Record<string, unknown>;
  const name = str(b.name, VENTURE_BRAND.name);

  // A workspace that named itself but never split a wordmark gets its name as
  // the bold half, so the header reads as theirs rather than as ours.
  const named = name !== VENTURE_BRAND.name;
  return {
    name,
    legalName: str(b.legalName, name),
    markBold: str(b.markBold, named ? name : VENTURE_BRAND.markBold),
    markLight: str(b.markLight, named ? "" : VENTURE_BRAND.markLight),
    logoUrl: typeof b.logoUrl === "string" && b.logoUrl.trim() ? b.logoUrl.trim() : null,
    logoPath: typeof b.logoPath === "string" && b.logoPath.trim() ? b.logoPath.trim() : null,
    color: color(b.color, VENTURE_BRAND.color),
    gradientFrom: color(b.gradientFrom, color(b.color, VENTURE_BRAND.gradientFrom)),
    gradientTo: color(b.gradientTo, color(b.color, VENTURE_BRAND.gradientTo)),
    canvas: color(b.canvas, VENTURE_BRAND.canvas),
    ink: color(b.ink, VENTURE_BRAND.ink),
    muted: color(b.muted, VENTURE_BRAND.muted),
    fontDisplay: fontName(b.fontDisplay, VENTURE_BRAND.fontDisplay),
    fontBody: fontName(b.fontBody, VENTURE_BRAND.fontBody),
    footerIdentity: str(b.footerIdentity, named ? name : VENTURE_BRAND.footerIdentity),
    footerAddress: optional(b.footerAddress),
    footerRegistration: optional(b.footerRegistration),
    footerContact: optional(b.footerContact),
    senderName: str(b.senderName, name),
    senderEmail:
      typeof b.senderEmail === "string" && b.senderEmail.includes("@")
        ? b.senderEmail.trim()
        : null,
    slugPrefix: str(b.slugPrefix, VENTURE_BRAND.slugPrefix).replace(/[^a-z0-9-]/gi, "") ||
      VENTURE_BRAND.slugPrefix,
    publicHost: host(b.publicHost),
  };
}

/** True when nothing has been customised — used to label the Settings form. */
export function isDefaultBrand(brand: WorkspaceBrand): boolean {
  return (
    brand.name === VENTURE_BRAND.name &&
    brand.color === VENTURE_BRAND.color &&
    brand.logoUrl === null
  );
}

/** `linear-gradient(...)` for whichever surface needs one. */
export function brandGradient(brand: WorkspaceBrand, angle = "135deg"): string {
  return `linear-gradient(${angle},${brand.gradientFrom},${brand.gradientTo})`;
}

// ---- readability -----------------------------------------------------------

/**
 * WCAG relative luminance. Used for the contrast gate below, which is the one
 * thing standing between a workspace and output nobody can read.
 */
export function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value.slice(0, 6);
  const channel = (pair: string): number => {
    const srgb = parseInt(pair, 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(full.slice(0, 2));
  const g = channel(full.slice(2, 4));
  const b = channel(full.slice(4, 6));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 1 (identical) to 21 (black on white). Symmetric, per the spec. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * WCAG AA for body text, the large-text threshold for secondary text, and a
 * much lower bar for the accent.
 *
 * The accent is deliberately NOT held to a text ratio. In this design system it
 * is a gradient fill and a border — accent TEXT is a separate, lighter colour —
 * and the seed's own purple sits at 2.74:1 against the navy canvas, which looks
 * correct because it appears as large filled shapes with a glow. Holding it to
 * 3:1 would have rejected the Venture palette with its own validator, which is
 * how a check like this gets switched off. The bar it does have to clear is
 * "visible at all", so nobody can configure an accent that vanishes.
 */
export const CONTRAST_TEXT = 4.5;
export const CONTRAST_MUTED = 3;
export const CONTRAST_ACCENT = 1.5;

export type ContrastResult = { ok: true } | { ok: false; problems: string[] };

/**
 * Refuse a palette that cannot be read.
 *
 * Checked on save rather than on render: a workspace that has already stored an
 * unreadable brand would have every artefact it ever produces be unreadable,
 * and discovering that from a client's emailed report is too late. Every
 * problem is reported at once — fixing them one round trip at a time is how a
 * form becomes something people give up on.
 */
export function validateBrandContrast(brand: WorkspaceBrand): ContrastResult {
  const problems: string[] = [];
  const check = (fg: string, bg: string, min: number, what: string) => {
    const ratio = contrastRatio(fg, bg);
    if (ratio < min) {
      problems.push(
        `${what} contrast is ${ratio.toFixed(1)}:1 against the canvas — needs at least ${min}:1.`,
      );
    }
  };
  check(brand.ink, brand.canvas, CONTRAST_TEXT, "Body text");
  check(brand.muted, brand.canvas, CONTRAST_MUTED, "Muted text");
  check(brand.color, brand.canvas, CONTRAST_ACCENT, "Accent");
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

// ---- derivation ------------------------------------------------------------

/**
 * A family name plus a fallback.
 *
 * Never a bare name: a PDF renders in headless Chrome with none of these fonts
 * installed, and a bare family would silently resolve to whatever the renderer
 * felt like rather than to something chosen.
 */
/** The exact chain the PDF templates used before the brand was configurable. */
const LEGACY_SANS = `-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

/**
 * The seed's hand-picked softened values, kept exactly.
 *
 * These live here, with the seed, rather than in the templates that used them:
 * that is the whole point of the module, and it is what lets the "no hardcoded
 * colour in a template" test be absolute rather than a list of exceptions.
 */
const SEED_INK_SOFT = "#C9CEE3";
const SEED_ACCENT_INK = "#E4D3FF";
/** Flattened equivalents of the translucent panel/border tokens over canvas. */
export const SEED_EMAIL_PANEL = "#0A0F26";
export const SEED_EMAIL_BORDER = "#1B2138";

function isSeedSurface(brand: WorkspaceBrand): boolean {
  return (
    brand.canvas === VENTURE_BRAND.canvas &&
    brand.ink === VENTURE_BRAND.ink &&
    brand.color === VENTURE_BRAND.color
  );
}

/** Blend two hex colours. Used to derive the softened surfaces. */
export function mixHex(from: string, to: string, amount: number): string {
  const parse = (hex: string) => {
    const v = hex.replace("#", "");
    const full = v.length === 3 ? v.split("").map((c) => c + c).join("") : v.slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const a = parse(from);
  const b = parse(to);
  return `#${a
    .map((c, i) => Math.round(c + (b[i] - c) * amount).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

export function brandFontStack(family: string): string {
  // THE SEED EMITS THE HISTORICAL CHAIN UNCHANGED, with nothing prepended.
  //
  // "prepending a font that is not installed is a no-op" was the assumption,
  // and it was wrong: Inter IS installed on plenty of machines, and where it is
  // it beats -apple-system and silently changes the typeface of every existing
  // PDF. A pixel comparison against the pre-change build caught it. A workspace
  // that chose a font gets it prepended; one that did not gets exactly what it
  // had before.
  if (family === VENTURE_BRAND.fontBody || family === VENTURE_BRAND.fontDisplay) {
    return LEGACY_SANS;
  }
  const serif = /(serif|georgia|times|garamond|playfair|merriweather)/i.test(family);
  // `system-ui` is deliberately absent from the fallback: it resolves on Linux
  // and would change what the existing PDFs render with.
  return serif
    ? `"${family}", Georgia, "Times New Roman", serif`
    : `"${family}", ${LEGACY_SANS}`;
}

/**
 * Every brand decision as a CSS custom property.
 *
 * Templates read `var(--brand-*)` instead of naming a token, which is what lets
 * one stylesheet serve every workspace — and what makes "no hardcoded brand
 * string" a property a grep test can actually check.
 */
export function brandCssVars(brand: WorkspaceBrand): Record<string, string> {
  return {
    "--brand-canvas": brand.canvas,
    "--brand-ink": brand.ink,
    // Dimmed body text and the light accent. Both were fixed light values in
    // the templates (#C9CEE3, #E4D3FF) and therefore invisible on a light
    // canvas. Derived by mixing toward the canvas so they dim in whichever
    // direction the theme runs — but the SEED keeps its hand-picked values
    // verbatim, because a mix lands near them and not on them, and "near" is a
    // changed document. (The same lesson the email panel taught.)
    "--brand-ink-soft": isSeedSurface(brand) ? SEED_INK_SOFT : mixHex(brand.ink, brand.canvas, 0.22),
    "--brand-accent-ink": isSeedSurface(brand)
      ? SEED_ACCENT_INK
      : mixHex(brand.color, brand.ink, 0.55),
    "--brand-muted": brand.muted,
    "--brand-accent": brand.color,
    "--brand-gradient-from": brand.gradientFrom,
    "--brand-gradient-to": brand.gradientTo,
    "--brand-gradient": brandGradient(brand),
    "--brand-font-display": brandFontStack(brand.fontDisplay),
    "--brand-font-body": brandFontStack(brand.fontBody),
  };
}

/** The same, as an inline `style` string for a PDF's root element. */
export function brandCssVarsInline(brand: WorkspaceBrand): string {
  return Object.entries(brandCssVars(brand))
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

/**
 * The footer, assembled from whatever is configured.
 *
 * Parts nobody filled in are omitted rather than left as empty separators, so a
 * workspace that only set an identity line gets exactly that line — which is
 * what keeps the Venture footer identical to what it always was.
 */
export function brandFooterLine(brand: WorkspaceBrand): string {
  return [brand.footerIdentity, brand.footerAddress, brand.footerRegistration, brand.footerContact]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join(" · ");
}

/**
 * The origin this workspace's public links are built on.
 *
 * A workspace with its own host gets it; everyone else gets the deployment's
 * configured public surface, which is what every existing link already used.
 */
export function publicBaseFor(brand: WorkspaceBrand, fallbackOrigin: string): string {
  return brand.publicHost ? `https://${brand.publicHost}` : fallbackOrigin;
}
