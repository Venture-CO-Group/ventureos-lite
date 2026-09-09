import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const COMPONENTS = join(ROOT, "src", "components");

/**
 * The accessibility rules a static read can enforce (playbook-v5 P16/4).
 *
 * axe runs on six screens in e2e/a11y.spec.ts, which is the real check — but
 * it only sees what those six screens render. A dialog behind a button nobody
 * clicked, a control that appears on one branch of a condition, a component
 * added next month: none of that is scanned. These two rules hold for the
 * whole tree, cheaply.
 */
const files = readdirSync(COMPONENTS)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => join(COMPONENTS, f));

describe("contrast against the dark canvas", () => {
  /**
   * WCAG relative luminance, then the ratio. Written out rather than pulled in
   * so the numbers in the design tokens can be checked without a dependency.
   */
  function luminance(hex: string): number {
    const n = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  }
  function ratio(a: string, b: string): number {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1! + 0.05) / (l2! + 0.05);
  }

  const CANVAS = "#00051D";
  /** `panel` is a 4% white wash over the canvas — the lightest real background. */
  const PANEL = "#0A0F27";

  it.each([
    ["ink", "#EFF1F8"],
    ["muted", "#858CAE"],
    ["accent-ink", "#C79BFF"],
  ])("%s reaches AA for body text on both backgrounds", (_name, colour) => {
    expect(ratio(colour, CANVAS)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(colour, PANEL)).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * `accent` is the CTA fill and the border colour, never text. Asserted so
   * that if somebody reaches for it as a text colour, this says why not.
   */
  it("accent is a fill, not a text colour, and the numbers say so", () => {
    expect(ratio("#7427C6", CANVAS)).toBeLessThan(4.5);
  });
});

describe("every icon-only button says what it does", () => {
  /**
   * A button whose entire content is an emoji, a symbol or an icon component
   * needs an accessible name, or a screen reader announces "button" and
   * nothing else. axe catches these only on the screens it visits.
   *
   * ── WHY THIS IS A SCANNER AND NOT A REGEX ──────────────────────────────────
   *
   * `<button([\s\S]*?)>` looks right and is wrong: an `onClick={() => f()}`
   * contains a `>`, so the attribute match stops inside the arrow and the
   * className spills into what the test thinks is the button's TEXT. A
   * className is full of letters, so every such button was read as
   * "labelled" — which is how a genuinely unnamed close button in
   * invoice-button.tsx passed this test until the guard was checked against a
   * deliberate regression. Finding the end of the opening tag needs brace and
   * string tracking, so that is what this does.
   */
  function buttons(src: string): { attrs: string; body: string }[] {
    const out: { attrs: string; body: string }[] = [];
    let i = 0;
    while ((i = src.indexOf("<button", i)) !== -1) {
      // Not <buttonSomething>.
      if (/[A-Za-z0-9]/.test(src[i + 7] ?? "")) {
        i += 7;
        continue;
      }
      let j = i + 7;
      let depth = 0;
      let quote = "";
      let selfClosing = false;
      for (; j < src.length; j++) {
        const c = src[j]!;
        if (quote) {
          if (c === quote) quote = "";
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          quote = c;
          continue;
        }
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) {
          selfClosing = src[j - 1] === "/";
          break;
        }
      }
      const attrs = src.slice(i + 7, j);
      if (selfClosing) {
        out.push({ attrs, body: "" });
        i = j + 1;
        continue;
      }
      const close = src.indexOf("</button>", j);
      out.push({ attrs, body: close === -1 ? "" : src.slice(j + 1, close) });
      i = close === -1 ? j + 1 : close + 9;
    }
    return out;
  }

  const OFFENDERS: { file: string; snippet: string }[] = [];

  for (const file of files) {
    for (const { attrs, body } of buttons(readFileSync(file, "utf8"))) {
      const named =
        /aria-label\s*=/.test(attrs) ||
        /aria-labelledby\s*=/.test(attrs) ||
        /title\s*=/.test(attrs);
      if (named) continue;

      /**
       * What a reader actually gets.
       *
       * Expressions are stripped, but their STRING LITERALS are kept first:
       * `{cond ? "Retry brief" : "Generate brief"}` is a real label, and an
       * earlier version reported the meetings button as unnamed because it
       * threw the whole ternary away and saw only the "✦" beside it. The
       * literals are paired by SPLITTING on the quote, because a regex matched
       * the `" : "` BETWEEN two strings and found only a colon.
       */
      const quoted = (text: string, quote: string) =>
        text.split(quote).filter((_, i) => i % 2 === 1);
      const literals = [...quoted(body, '"'), ...quoted(body, "`")].join(" ");
      const text = `${body
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/<[^>]*>/g, "")
        .replace(/\{[^{}]*\}/g, "")} ${literals}`.trim();

      /**
       * A body that INTERPOLATES something has its label in the data —
       * `{s.keyword} · {s.location}` renders real text, it just is not visible
       * here. Only a body that is literally nothing but a symbol is an
       * icon-only button, so anything with an identifier inside braces is
       * left alone. (A `{icon}` holding an SVG would slip through; the axe
       * scan covers what actually renders.)
       */
      const dynamic = /\{[^{}]*[A-Za-z_$][^{}]*\}/.test(
        body.replace(/\{\/\*[\s\S]*?\*\/\}/g, ""),
      );
      if (dynamic) continue;

      // Letters or digits mean there is a real label in there.
      if (/[\p{L}\p{N}]/u.test(text)) continue;
      // Nothing but symbols, and no accessible name.
      if (text.length === 0) continue;
      OFFENDERS.push({ file: file.replace(`${ROOT}/`, ""), snippet: text.slice(0, 12) });
    }
  }

  it("has no unnamed symbol-only buttons", () => {
    expect(
      OFFENDERS,
      OFFENDERS.map((o) => `${o.file}: a button containing only "${o.snippet}"`).join("\n"),
    ).toEqual([]);
  });
});
