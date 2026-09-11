/**
 * WCAG AA proof for the design tokens, read from `globals.css` itself.
 *
 * This exists because the failure mode is INVISIBLE in the theme you are
 * working in. A status surface written as an alpha of its own hue
 * (`bg-urgency-blocking/12`) darkens a white card and holds contrast, but
 * LIGHTENS a dark card toward the already-light dark-mode hue — one shipped
 * pairing measured 3.79:1, and `text-white` on the dark-mode red measured
 * 2.89:1, both while looking correct in light mode.
 *
 * It reads the real token values so a palette edit cannot pass by editing the
 * test's own copy, and it converts them here because `getComputedStyle` returns
 * `oklch()`/`lab()` — an in-page contrast probe silently reports nonsense.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(import.meta.dirname, "..", "src", "app", "globals.css"), "utf8");

/** sRGB relative luminance of an `oklch(L C H)` triple. */
function luminance(L: number, C: number, hueDeg: number): number {
  const h = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  // Already linear-light, so the sRGB transfer function is not applied again.
  return 0.2126 * Math.max(0, linear[0]) + 0.7152 * Math.max(0, linear[1]) + 0.0722 * Math.max(0, linear[2]);
}

/**
 * The `oklch(L C H)` value of `name` inside the `:root` or `.dark` block.
 *
 * Throws rather than returning a default: a renamed or reformatted token must
 * fail this file loudly instead of silently skipping its contrast check.
 */
function token(theme: "light" | "dark", name: string): { L: number; C: number; H: number } {
  const block = theme === "light" ? /^:root \{$/m : /^\.dark \{$/m;
  const start = CSS.search(block);
  if (start === -1) throw new Error(`no ${theme} token block in globals.css`);
  const body = CSS.slice(start, CSS.indexOf("\n}", start));
  const found = new RegExp(`^\\s*--${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`, "m").exec(body);
  if (found === null) {
    throw new Error(`--${name} is not an opaque oklch() triple in the ${theme} block of globals.css`);
  }
  return { L: Number(found[1]), C: Number(found[2]), H: Number(found[3]) };
}

function contrast(theme: "light" | "dark", ink: string, surface: string): number {
  const a = luminance(...(Object.values(token(theme, ink)) as [number, number, number]));
  const b = luminance(...(Object.values(token(theme, surface)) as [number, number, number]));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Ink-on-surface pairs the cockpit actually renders. `card` is the white surface. */
const TEXT_PAIRS: readonly (readonly [ink: string, surface: string])[] = [
  ["foreground", "card"],
  ["foreground-secondary", "card"],
  ["muted-foreground", "card"],
  // Meta text also sits on the `muted` track (the panel switch, a count pill),
  // which is where the shipped default measured 4.46:1.
  ["muted-foreground", "muted"],
  ["muted-foreground", "background"],
  ["primary", "card"],
  ["primary", "primary-tint"],
  // An engaged toggle's HOVER surface. State surfaces need the same proof as
  // resting ones, because a theme swap breaks state and style independently.
  ["primary", "primary-tint-hover"],
  ["primary-foreground", "primary"],
  ["urgency-blocking", "card"],
  ["urgency-blocking", "urgency-blocking-tint"],
  // The regression this file was written for.
  ["urgency-blocking-foreground", "urgency-blocking"],
  ["urgency-attention", "urgency-attention-tint"],
  ["success", "success-tint"],
];

/** Non-text marks: a dot or a glyph, which WCAG holds to 3:1. */
const GLYPH_PAIRS: readonly (readonly [ink: string, surface: string])[] = [
  ["urgency-quiet", "secondary"],
  ["urgency-quiet", "background"],
];

describe.each(["light", "dark"] as const)("%s theme meets WCAG AA", (theme) => {
  it.each(TEXT_PAIRS)("%s on %s clears 4.5:1", (ink, surface) => {
    expect(contrast(theme, ink, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(GLYPH_PAIRS)("%s on %s clears 3:1", (ink, surface) => {
    expect(contrast(theme, ink, surface)).toBeGreaterThanOrEqual(3);
  });
});

describe("status surfaces are per-theme tokens, not alphas", () => {
  /**
   * The tint tokens must be OPAQUE. An alpha would reintroduce the exact bug
   * this file guards, and `token()` already rejects a non-`oklch(L C H)` value,
   * so resolving each one is the assertion.
   */
  it.each(["urgency-blocking-tint", "urgency-attention-tint", "success-tint", "primary-tint"])(
    "--%s is opaque in both themes",
    (name) => {
      expect(token("light", name).L).toBeGreaterThan(0.5);
      expect(token("dark", name).L).toBeLessThan(0.5);
    },
  );

  it("no component reaches for an alpha of a status hue", () => {
    const sources = ["inbox-card", "helm-shell", "fleet-panel", "terminal-pane"].map((name) =>
      readFileSync(join(import.meta.dirname, "..", "src", "components", `${name}.tsx`), "utf8"),
    );
    // `bg-urgency-blocking/12`-style tints are the banned form; a BORDER or a
    // ring alpha is fine, because neither carries text.
    const banned = /bg-(urgency-blocking|urgency-attention|success|info|primary|destructive)\/\d+/;
    for (const source of sources) expect(source).not.toMatch(banned);
  });
});
