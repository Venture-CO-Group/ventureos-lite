/**
 * The candidate pool's pure parts (spec §4.43.3, §4.43.5): dedupe keys, what
 * a company name already tells us, and the priority order detail lookups are
 * spent in. No I/O — the run engine feeds these and acts on the answers.
 */
import type { PoolSource } from "@prisma/client";
import { cegadatTaxId } from "@/modules/registry/cegadat";
import type { SizeBand } from "./size-band";

export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Lowercased, accent-folded, legal suffix stripped — for name comparisons. */
export function foldName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(kft|zrt|nyrt|bt|kkt|e\.?v|ev|kft\.|zrt\.)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Tax number when we have one — it is the registry's own identity and the
 * CRM's dedupe key. Otherwise domain plus folded name, which is weaker but is
 * all a Places result or a bare CSV row carries.
 */
export function dedupeKeyFor(input: { taxNumber?: string | null; website?: string | null; name: string }): string {
  const tax = input.taxNumber ? cegadatTaxId(input.taxNumber) : null;
  if (tax) return `tax:${tax}`;
  return `web:${domainOf(input.website) ?? ""}|${foldName(input.name)}`;
}

/** The legal form a name ends in, when it ends in one. */
export function legalFormFromName(name: string): string | null {
  const m = /\b(Kft|Zrt|Nyrt|Bt|Kkt|e\.v|E\.V|Egyéni vállalkozó)\.?\s*(\(.*\))?\s*$/i.exec(name.trim());
  if (!m) return null;
  const f = m[1]!.toLowerCase();
  return f === "kft" ? "Kft." : f === "zrt" ? "Zrt." : f === "nyrt" ? "Nyrt." : f === "bt" ? "Bt." : f === "kkt" ? "Kkt." : "e.v.";
}

/**
 * A partnership or a sole trader is not a large company. Used to push such
 * names down the queue when the profile wants medium or large firms — not to
 * drop them, because a name is a hint and the registry is the answer.
 */
export function legalFormImplausible(form: string | null, bands: readonly SizeBand[]): boolean {
  if (!form || bands.length === 0) return false;
  const small = form === "Bt." || form === "Kkt." || form === "e.v.";
  return small && bands.every((b) => b === "MEDIUM" || b === "LARGE");
}

/** Which of the given fragments occur in a name, word-start anchored. */
export function fragmentsInName(name: string, fragments: readonly string[]): string[] {
  const hay = ` ${foldName(name)} `;
  return fragments.filter((f) => {
    const needle = foldName(f);
    return needle.length > 0 && (hay.includes(` ${needle}`) || hay.includes(needle));
  });
}

export interface PoolRowForScoring {
  name: string;
  source: PoolSource;
  segmentKeys: string[];
  hits: Array<{ segment: string; fragment: string }>;
  lastSeenAt: Date;
}

export interface ScoringContext {
  profileSegments: readonly string[];
  /** Every fragment of the profile's segments. */
  profileFragments: readonly string[];
  /** Fragments of segments the profile did NOT ask for. */
  otherFragments: readonly string[];
  sizeBands: readonly SizeBand[];
  /** Observed approval rate per fragment, when there is enough history. */
  fragmentApproval: ReadonlyMap<string, number>;
  now: Date;
}

/**
 * Priority — highest first, detail lookups are spent in this order.
 *
 * Every term is small and explainable: the source (a hand-curated seed list
 * beats a harvested name), how strongly the name says the segment, whether
 * the legal form can be the size we want, what the fragment that found it has
 * historically produced, and how recently we saw it.
 */
export function scorePoolRow(row: PoolRowForScoring, ctx: ScoringContext): number {
  let score = 0;
  score += row.source === "SEED_LIST" ? 30 : row.source === "CSV" ? 20 : row.source === "PLACES" ? 10 : 0;

  const own = fragmentsInName(row.name, ctx.profileFragments);
  score += Math.min(3, own.length) * 10;
  // A name that clearly says ANOTHER segment and nothing of ours is probably
  // a false friend ("Autó" in a dentists' harvest).
  if (own.length === 0 && fragmentsInName(row.name, ctx.otherFragments).length > 0) score -= 15;

  if (legalFormImplausible(legalFormFromName(row.name), ctx.sizeBands)) score -= 20;

  const rates = row.hits
    .filter((h) => ctx.profileSegments.includes(h.segment))
    .map((h) => ctx.fragmentApproval.get(h.fragment))
    .filter((r): r is number => typeof r === "number");
  if (rates.length > 0) score += Math.max(...rates) * 20;

  const ageDays = (ctx.now.getTime() - row.lastSeenAt.getTime()) / 86_400_000;
  if (ageDays <= 30) score += 5;
  return Math.round(score * 100) / 100;
}
