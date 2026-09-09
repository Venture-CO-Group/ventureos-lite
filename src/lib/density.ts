/**
 * Row density (playbook-v5 P16/6).
 *
 * Inert: read by a server component to stamp the shell, by the settings panel
 * to render the toggle, and by nothing else. The actual sizes live in
 * globals.css as four custom properties, so a table and a board read the same
 * tokens and "compact" is one declaration rather than forty class swaps that
 * drift apart the moment somebody adds a column.
 */
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const DEFAULT_DENSITY: Density = "comfortable";

export const DENSITY_LABEL: Record<Density, string> = {
  comfortable: "Comfortable",
  compact: "Compact",
};

export const DENSITY_HELP: Record<Density, string> = {
  comfortable: "Roomy rows. The default.",
  compact: "More rows on screen. Ignored on a phone, where targets stay tappable.",
};

/** Null (never chosen) and anything unexpected both read as the default. */
export function toDensity(value: string | null | undefined): Density {
  return value === "compact" ? "compact" : DEFAULT_DENSITY;
}
