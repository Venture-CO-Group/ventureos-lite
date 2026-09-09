import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DENSITY, DENSITIES, DENSITY_HELP, DENSITY_LABEL, toDensity } from "../../src/lib/density";

const CSS = readFileSync(join(__dirname, "..", "..", "src", "app", "globals.css"), "utf8");

describe("the density preference", () => {
  it("falls back to comfortable for null, unknown and rubbish", () => {
    expect(toDensity(null)).toBe("comfortable");
    expect(toDensity(undefined)).toBe("comfortable");
    expect(toDensity("")).toBe("comfortable");
    expect(toDensity("ultra")).toBe("comfortable");
    expect(toDensity("COMPACT")).toBe("comfortable");
  });

  it("reads compact when that is what was chosen", () => {
    expect(toDensity("compact")).toBe("compact");
  });

  it("labels and explains every option, so neither is a mystery", () => {
    for (const d of DENSITIES) {
      expect(DENSITY_LABEL[d]).toBeTruthy();
      expect(DENSITY_HELP[d].length).toBeGreaterThan(10);
    }
    expect(DEFAULT_DENSITY).toBe("comfortable");
  });
});

/**
 * The tokens themselves, read out of the stylesheet.
 *
 * The point of the token layer is that compact is ONE declaration rather than
 * per-component class swaps that drift apart. So the thing worth asserting is
 * that the tokens exist, that compact is genuinely tighter, and — the rule that
 * overrides the preference — that a phone gets the comfortable values back.
 */
describe("the density tokens", () => {
  const TOKENS = ["--row-py", "--cell-px", "--card-p", "--stack-gap"];

  /**
   * Searched from the density section onwards, not from the top of the file:
   * globals.css has an earlier `:root` for `color-scheme`, and matching that
   * one made this test assert against a block with no density tokens in it —
   * which it duly reported as missing.
   */
  const SECTION = CSS.indexOf("Density (playbook-v5 P16/6)");

  function block(selector: string): string {
    expect(SECTION, "the density section is missing from globals.css").toBeGreaterThan(-1);
    const i = CSS.indexOf(selector, SECTION);
    expect(i, `${selector} missing from the density section`).toBeGreaterThan(-1);
    return CSS.slice(i, CSS.indexOf("}", i));
  }

  it("declares every token at the root", () => {
    const root = block(":root {");
    for (const t of TOKENS) expect(root, t).toContain(t);
  });

  it("declares every token for compact", () => {
    const compact = block('[data-density="compact"] {');
    for (const t of TOKENS) expect(compact, t).toContain(t);
  });

  it("makes compact tighter than comfortable, for every token", () => {
    const px = (source: string, token: string) =>
      Number(new RegExp(`${token}:\\s*(\\d+)px`).exec(source)?.[1]);
    const root = block(":root {");
    const compact = block('[data-density="compact"] {');
    for (const t of TOKENS) {
      expect(px(compact, t), `${t} should be smaller when compact`).toBeLessThan(px(root, t));
    }
  });

  /**
   * 44px touch targets are a hard rule (CLAUDE.md → Responsive), and compact
   * row heights cannot honour them — so below the shell's breakpoint the
   * preference is overridden. Asserted from the stylesheet because it is the
   * only place the rule exists.
   */
  it("puts the comfortable values back on a phone", () => {
    const i = CSS.indexOf("@media (max-width: 699px)", SECTION);
    expect(i, "the phone override is missing").toBeGreaterThan(-1);
    const phone = CSS.slice(i, CSS.indexOf("\n}", CSS.indexOf("}", i) + 1));
    expect(phone).toContain('[data-density="compact"]');
    const root = block(":root {");
    const px = (source: string, token: string) =>
      Number(new RegExp(`${token}:\\s*(\\d+)px`).exec(source)?.[1]);
    for (const t of TOKENS) {
      expect(px(phone, t), `${t} should return to its comfortable value on a phone`).toBe(
        px(root, t),
      );
    }
  });

  /**
   * And the surfaces actually read them. A token layer nothing consumes is a
   * stylesheet comment.
   */
  it("is consumed by the tables and the boards", () => {
    const ROOT = join(__dirname, "..", "..");
    for (const file of [
      "src/components/leads-table.tsx",
      "src/components/task-board.tsx",
      "src/components/pipeline-board.tsx",
      "src/components/deals-board.tsx",
    ]) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(/var\(--(row-py|cell-px|card-p|stack-gap)\)/.test(src), file).toBe(true);
    }
  });
});
