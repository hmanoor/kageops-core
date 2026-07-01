/**
 * KageOps Design Pack
 *
 * A drop-in design system for any agent that produces HTML/CSS
 * artifacts (Forge for static-HTML projects, Pixel as a fallback,
 * acceptance retry tasks). Goal: prevent generic-looking output by
 * giving the model a concrete tokens layer and explicit restraint
 * rules instead of "make it polished".
 *
 * The pack is the same vocabulary the KageOps Command Center uses
 * (see src/renderer/command-center/tokens.css) — Linear/Vercel grade
 * neutral chrome, oklch palette, hairline borders, no glows.
 *
 * Inject `BASE_DESIGN_PROMPT` into prompts; emit `BASE_TOKENS_CSS`
 * verbatim into a `--- FILE: tokens.css ---` block when the task has
 * no existing token sheet.
 */

// ── Public API ───────────────────────────────────────

/**
 * Concrete design system rules for HTML/CSS work. Append this to
 * any UI-generation prompt where the model would otherwise improvise.
 * Keeps the rules bounded so the prompt cost stays predictable.
 *
 * BRAND COLOR POLICY: this pack only ships discipline defaults
 * (spacing, type, hairline borders, no-shadow rule, etc.). The actual
 * accent + neutral palette MUST come from the project brief. If the
 * brief specifies brand colours (e.g. "forest green accent", "sea-salt
 * blue", a hex code, a brand reference), use those verbatim — DO NOT
 * substitute the placeholder values below. If the brief is silent on
 * colour, fall back to the neutral defaults listed.
 */
export const BASE_DESIGN_PROMPT = `
DESIGN DISCIPLINE (apply unless the project brief explicitly overrides
a specific rule — the brief always wins)

Visual language: pure restraint (Linear / Vercel / Stripe / Apple-grade).
NO drop shadows beyond a 1px focus ring, NO glows, NO gradients except
subtle text gradients on display headings, NO Bootstrap / Tailwind /
Material / Chakra utility soup.

COLOUR PALETTE — derive from the project brief

The accent colour, brand neutrals, and any status colours come from
the project description. If the brief names colours (hex codes, brand
references like "sea-salt blue" or "forest green", or a reference site
like bupa.com.au), use exactly those. Do NOT default to moss green,
forest green, blue, or any other colour family unless the brief asks
for it.

If — and only if — the brief is silent on colour, fall back to a
neutral monochrome with a single warm grey accent (e.g. #6B6B6B for
the accent role) so the page is presentable without inventing a brand.

Surfaces (neutral fallback only — replace with brief-specified values):
  --bg:               #0A0A0A    /  #FAFAFA   (page)
  --surface:          #141414    /  #FFFFFF   (panels, cards)
  --surface-sunken:   #0F0F0F    /  #F5F5F5   (input wells)
  --surface-elevated: #1A1A1A    /  #FFFFFF   (modals, popovers)

Text (neutral fallback only — replace with brief-specified values):
  --text-primary:    #F5F5F5  /  #0A0A0A
  --text-secondary:  #A3A3A3  /  #525252
  --text-muted:      #6B6B6B  /  #737373

Borders — hairline only:
  --border:          rgba(255,255,255,0.10) on dark
  --border:          rgba(0,0,0,0.10)       on light
  --border-strong:   rgba(255,255,255,0.16) / rgba(0,0,0,0.16)

Accent — derive from brief. Placeholder only:
  --accent:          <use the colour from the project brief>
  Use sparingly (CTAs, active state, one accent visible at a time).

Typography:
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI",
               system-ui, sans-serif
  Body:  13px / line-height 1.45
  Small: 11px / line-height 1.4
  H1:    52px / 1.05 / -0.02em / weight 600
  H2:    36px / 1.1  / -0.02em / weight 600
  H3:    20px / 1.2  / -0.01em / weight 600
  Mono:  "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas,
         monospace

Spacing: 4px grid. Use 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64.
Radius:  3 / 6 / 8 / 12. Default 6 for cards, 3 for inputs.

Components:
  Card  — 1px hairline border, 6px radius, 16px padding, no shadow.
  Button (primary)   — accent bg, white text, 6px radius, 10px 16px.
  Button (secondary) — transparent, hairline border, 6px radius.
  Input — 1px border, 3px radius, 8px 12px padding, focus ring is
          a 2px outline in --accent at 40% alpha.
  Hero  — single column, max-width 720px, 96px top padding minimum.
  Nav   — sticky, 56px height, hairline bottom border, blur-12px
          backdrop on scroll.

Layout:
  Container max-width: 1200px, 24px gutter.
  Section vertical rhythm: 96px (desktop) / 64px (mobile).
  Use CSS Grid for two-column / three-column patterns. Avoid floats.

Required for every page:
  - <meta name="viewport" content="width=device-width, initial-scale=1">
  - prefers-color-scheme support OR an explicit data-theme="dark|light"
    attribute on <html> with both palettes wired
  - All interactive elements reachable by keyboard (Tab order)
  - aria-labels on icon-only buttons
  - Reduced-motion media query disabling non-essential animations

Forbidden:
  - Bootstrap, Tailwind utility classes, Materialize, ChakraUI
  - Box shadows beyond a 0 0 0 1px ring on focus
  - Gradients other than text gradients on display headings
  - Drop caps, decorative emoji, clip-art icons
  - Inline <style> blocks larger than 30 lines (extract to CSS file)
`.trim();

/**
 * Palette-free tokens.css skeleton — every surface/text/accent value is
 * a `TODO_FROM_BRIEF` placeholder the model MUST replace using the
 * project description's brand colours (named, hex, or reference site).
 *
 * Previously this constant shipped the KageOps Command Center dark
 * theme verbatim (`#0A0A0A` page, moss-green accent) labelled as a
 * "TOKEN-SHEET STARTING POINT". Even with a "don't default to moss
 * green" rule above it, models copied the file as-is and every project
 * came out wearing KageOps' brand. Removing the values forces the
 * model to do the colour-derivation step instead of taking the path
 * of least resistance.
 *
 * Structural defaults (spacing grid, type scale, radius, motion,
 * reset) remain — those are discipline, not brand.
 */
export const BASE_TOKENS_CSS = `/* tokens.css — REPLACE every TODO_FROM_BRIEF with a value derived from
   the project description's brand colours. Do NOT leave TODO_FROM_BRIEF
   in the final file. If the brief is colour-silent, use neutral monochrome
   (#0A0A0A / #FAFAFA + a warm grey accent like #6B6B6B). Both dark
   (default) and light themes via [data-theme="light"]. */

:root {
    color-scheme: dark;

    /* Surfaces — derive from the project brief */
    --bg:               TODO_FROM_BRIEF;  /* page background */
    --surface:          TODO_FROM_BRIEF;  /* panels, cards */
    --surface-sunken:   TODO_FROM_BRIEF;  /* input wells */
    --surface-elevated: TODO_FROM_BRIEF;  /* modals, popovers */

    /* Text — derive from the project brief, must hit WCAG AA on --bg */
    --text-primary:   TODO_FROM_BRIEF;
    --text-secondary: TODO_FROM_BRIEF;
    --text-muted:     TODO_FROM_BRIEF;

    /* Borders — hairline only (these alpha rgba values rarely change) */
    --border:        rgba(255, 255, 255, 0.10);
    --border-strong: rgba(255, 255, 255, 0.16);
    --border-subtle: rgba(255, 255, 255, 0.06);

    /* Accent — derive from the project brief. ONE accent, used sparingly. */
    --accent:        TODO_FROM_BRIEF;
    --accent-strong: TODO_FROM_BRIEF;
    --accent-faint:  TODO_FROM_BRIEF;

    /* Typography — discipline defaults, swap font-sans if the brief
       names a typeface (e.g. "uses Söhne", "Playfair display headings"). */
    --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI",
                 system-ui, "Helvetica Neue", Arial, sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", "Berkeley Mono",
                 Menlo, Consolas, monospace;

    --text-xs:   11px;
    --text-sm:   12px;
    --text-base: 13px;
    --text-md:   14px;
    --text-lg:   16px;
    --text-xl:   20px;
    --text-2xl:  26px;
    --text-3xl:  36px;
    --text-4xl:  52px;

    --leading-tight:   1.2;
    --leading-normal:  1.45;
    --leading-relaxed: 1.6;

    /* Spacing — 4px grid (discipline default, keep) */
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 24px;
    --space-6: 32px;
    --space-7: 48px;
    --space-8: 64px;
    --space-9: 96px;

    /* Radius (discipline default, keep) */
    --radius-sm:   3px;
    --radius:      6px;
    --radius-md:   8px;
    --radius-lg:   12px;
    --radius-full: 9999px;

    /* Motion (discipline default, keep) */
    --ease:        cubic-bezier(0.2, 0, 0, 1);
    --motion-fast: 120ms;
    --motion-base: 200ms;
}

[data-theme="light"] {
    color-scheme: light;
    --bg:               TODO_FROM_BRIEF;
    --surface:          TODO_FROM_BRIEF;
    --surface-sunken:   TODO_FROM_BRIEF;
    --surface-elevated: TODO_FROM_BRIEF;
    --text-primary:     TODO_FROM_BRIEF;
    --text-secondary:   TODO_FROM_BRIEF;
    --text-muted:       TODO_FROM_BRIEF;
    --border:           rgba(0, 0, 0, 0.10);
    --border-strong:    rgba(0, 0, 0, 0.16);
    --border-subtle:    rgba(0, 0, 0, 0.06);
}

/* Reset + base (keep as-is) */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: var(--leading-normal);
    color: var(--text-primary);
    background: var(--bg);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
}
a { color: inherit; text-decoration: none; }
button { font-family: inherit; }
@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

/**
 * Bundle design discipline — same restraint as BASE_DESIGN_PROMPT, but for a
 * Tailwind + shadcn/ui stack (the nextjs-saas bundle). The static-HTML pack
 * FORBIDS Tailwind and ships a vanilla tokens.css; injecting it into the bundle
 * path would contradict the scaffold. This variant keeps the discipline (one
 * accent, hairline borders, no shadows, generous whitespace, type hierarchy,
 * brief-derived palette) and tells the model to express brand through the
 * scaffold's shadcn CSS variables in `app/globals.css` — NOT ad-hoc colours.
 */
export const BUNDLE_DESIGN_PROMPT = `
DESIGN DISCIPLINE — Tailwind + shadcn/ui (apply unless the brief overrides a
specific rule — the brief always wins)

Visual language: pure restraint (Linear / Vercel / Stripe / Apple-grade). This
is a Tailwind + shadcn/ui app, so utility classes and shadcn components are the
RIGHT tools here — but use them with discipline, not "utility soup".

BRAND COLOUR — derive from the brief, set it in ONE place
  The scaffold's palette lives as HSL CSS variables in \`app/globals.css\`
  (\`:root\` for light, \`.dark\` for dark) — \`--background\`, \`--foreground\`,
  \`--primary\`, \`--muted\`, \`--muted-foreground\`, \`--border\`, \`--ring\`,
  \`--radius\` — wired into Tailwind via \`tailwind.config.ts\`.
  - Derive the brand palette from the project brief. If the brief names colours
    (hex, "forest green", a reference site), set them as the HSL values of
    \`--primary\` (the accent) + neutrals in BOTH \`:root\` and \`.dark\`.
  - If the brief is colour-silent, keep the scaffold's neutral monochrome.
  - Do NOT hardcode colours in components (no \`bg-[#1e90ff]\`, no
    \`text-green-500\`). Style via the semantic tokens — \`bg-primary\`,
    \`text-muted-foreground\`, \`border-border\`, \`bg-background\` — so theme +
    dark mode stay coherent. ONE accent, used sparingly (primary CTA, active state).

RESTRAINT
  - NO drop shadows beyond a focus ring; prefer \`border\` (hairline) for
    separation over \`shadow-lg\`. NO glows, NO gradients except a subtle text
    gradient on a display heading.
  - Generous whitespace: section rhythm ~\`py-24\` desktop / \`py-16\` mobile,
    container \`max-w-6xl mx-auto px-6\`. Don't crowd.
  - Type hierarchy: large, tight display headings (\`text-4xl md:text-5xl
    font-semibold tracking-tight\`), calm body (\`text-muted-foreground\`,
    \`leading-relaxed\`). Use weight + size for hierarchy, not colour noise.
  - Radius: lean on the scaffold's \`--radius\` (\`rounded-lg\`/\`rounded-md\`).
    Cards: hairline \`border\` + \`rounded-lg\` + padding, NO shadow.
  - Reuse shadcn primitives (Button, Card, Input) instead of re-styling raw
    elements; keep variants consistent across the app.

REQUIRED
  - Responsive (mobile-first); every interactive element keyboard-reachable.
  - Respect the existing dark-mode wiring (\`.dark\` class) — don't break it.
  - aria-labels on icon-only buttons.

FORBIDDEN
  - Hardcoded colour literals in components (\`bg-[#...]\`, \`text-red-500\`) —
    go through the semantic tokens.
  - Heavy shadows, glows, decorative gradients, clip-art icons, emoji as UI.
  - Inventing a second accent or a different colour family than the brief asks for.
`.trim();

/**
 * Build a bundle-path design context block. No tokens.css skeleton (the bundle
 * ships its own globals.css); just the Tailwind/shadcn discipline.
 */
export function buildBundleDesignContext(): string {
    return ['--- DESIGN SYSTEM (Tailwind + shadcn/ui) ---', BUNDLE_DESIGN_PROMPT].join('\n\n');
}

/**
 * Returns true if a task description / type plausibly produces an
 * HTML/CSS artifact and should receive the design pack. Conservative
 * — false negative is fine (model still works without pack), false
 * positive just spends a few hundred tokens on a non-UI task.
 */
export function shouldInjectDesignPack(text: string, taskType: string): boolean {
    const lower = `${taskType} ${text}`.toLowerCase();
    if (lower.includes('html') || lower.includes('css') || lower.includes('landing')) return true;
    if (lower.includes('page') || lower.includes('site') || lower.includes('webpage')) return true;
    if (lower.includes('ui-build') || lower.includes('create-ui')) return true;
    if (lower.includes('marketing') || lower.includes('blog')) return true;
    return false;
}

/**
 * Build a context block to append to a UI-generation prompt.
 * Pass the existing project file list so the pack only mentions
 * tokens.css if the project doesn't already have a token sheet.
 */
export function buildDesignContext(opts: { readonly hasTokenSheet: boolean }): string {
    const sections: string[] = [];
    sections.push('--- DESIGN SYSTEM ---');
    sections.push(BASE_DESIGN_PROMPT);
    if (!opts.hasTokenSheet) {
        sections.push(
            '--- TOKENS.CSS SKELETON (structure only — every TODO_FROM_BRIEF ' +
            'placeholder MUST be replaced with a value derived from the project ' +
            'description\'s brand colours; do NOT ship a tokens.css that still ' +
            'contains TODO_FROM_BRIEF) ---'
        );
        sections.push(BASE_TOKENS_CSS);
    }
    return sections.join('\n\n');
}
