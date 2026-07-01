/**
 * P1-11 — vanilla-html bundle equivalence test.
 *
 * The whole point of Pillar 1.3 is "moving the static-HTML scaffold
 * out of Forge into a bundle changes nothing observable about the
 * output." This test is the CI gate that proves it.
 *
 * Strategy:
 *   - Load the REAL `bundles/stacks/vanilla-html/` directory from
 *     the repo (no fixtures, no fakes).
 *   - Render `forge_create_ui` + `forge_implement_feature` with the
 *     same vars the inline Forge code would substitute.
 *   - Compare character-for-character against copy-pasted snapshots
 *     of the inline strings from `src/agents/specialists/forge.ts`.
 *
 * When the operator retires the inline path in the v0.3.x cleanup PR
 * (plan decision #3), this test + the snapshot constants below get
 * deleted in the same commit.
 *
 * If the inline prompt is edited but the bundle isn't (or vice
 * versa), this test fails and forces them to drift back into sync.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { loadBundles } from '../../src/bundles/bundle-loader';
import { BundleRegistry } from '../../src/bundles/bundle-registry';
import { renderBundlePrompt } from '../../src/bundles/bundle-prompt-renderer';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLES_ROOT = path.join(REPO_ROOT, 'bundles');

// ── Sample task fields used by both code paths ──
const SAMPLE_TITLE = 'Build Solarsizer landing page';
const SAMPLE_DESCRIPTION =
    'A single-page solar calculator. Required ids: #headline, #inputs, #result.';

// ── Snapshot of the inline `basePrompt` from setupStaticHtmlProject (forge.ts:1138-1205) ──
// EDITING THIS: if you change `bundles/stacks/vanilla-html/prompts/forge-create-ui.md`,
// the inline Forge prompt should change to match — or vice versa. The test fails until
// both move in lockstep. When the inline path is deleted, delete this constant too.
const INLINE_CREATE_UI_PROMPT =
    `Set up a PURE STATIC HTML project — no Node, no npm, no build step, no test framework.\n\n` +
    `Title: ${SAMPLE_TITLE}\n` +
    `Description: ${SAMPLE_DESCRIPTION}\n\n` +
    `Generate EXACTLY these files at the project root (path strings must match exactly — no\n` +
    `subdirectories like \`landing/\` or \`src/\`):\n` +
    `1. \`index.html\` — at the project root. Semantic HTML5. References \`styles.css\` and \`script.js\`\n` +
    `   as siblings (\`<link rel="stylesheet" href="styles.css">\`, \`<script src="script.js">\`).\n` +
    `2. \`styles.css\` — at the project root. Full DESIGN SYSTEM implementation. Use the provided\n` +
    `   tokens.css SKELETON as the structure, but replace every \`TODO_FROM_BRIEF\` value with a\n` +
    `   colour you derive from the project description. The brief is authoritative: if it names\n` +
    `   colours (hex, named, or a reference site), use those verbatim. If the brief is\n` +
    `   colour-silent, fall back to a neutral monochrome (e.g. #0A0A0A bg / #FAFAFA light, warm\n` +
    `   grey #6B6B6B accent) — do NOT default to KageOps moss-green tokens. styles.css MUST NOT\n` +
    `   contain the literal string \`TODO_FROM_BRIEF\` in the output. Implement components using\n` +
    `   var(--accent) etc.\n` +
    `   Minimum 80 lines, every \`{\` matched by \`}\`. No truncation.\n` +
    `   CSS COMPLETENESS (NON-NEGOTIABLE): for EVERY \`class="..."\` value you put in index.html,\n` +
    `   styles.css MUST contain a matching \`.<className> { ... }\` rule. After you draft the HTML,\n` +
    `   list every distinct class name you used and add a rule for each one before you emit\n` +
    `   styles.css. A page that references \`.sigil-card\` or \`.phase-item\` without those rules\n` +
    `   defined will fail acceptance and you will be asked to redo it.\n` +
    `   F-371: CSS MUST live in styles.css — NOT inlined as a giant <style> block inside\n` +
    `   index.html. Even when the design system is large, emit a separate FILE block for\n` +
    `   styles.css. Vigil will reject any index.html whose inline <style> exceeds 40 lines\n` +
    `   when a separate styles.css could have been written instead.\n` +
    `3. \`script.js\` — at the project root. Vanilla ES2022, no modules, no imports. Always\n` +
    `   null-guard DOM lookups: \`document.querySelector('.x')?.addEventListener(...)\`.\n` +
    `4. \`README.md\` — at the project root. How to open (\`npx serve .\` or double-click).\n` +
    `5. If the description mentions MULTIPLE PAGES, additional .html files at the root only,\n` +
    `   never inside a subdirectory.\n\n` +
    `STRUCTURAL CONTENT (NON-NEGOTIABLE):\n` +
    `- Read the description above CAREFULLY. Use the EXACT section IDs, headlines, and components\n` +
    `  it specifies. Do NOT substitute generic SaaS sections like #features / #pricing / #faq\n` +
    `  unless the description explicitly says so.\n` +
    `- If the description lists required <section id="..."> values (e.g. #top, #agents, #how),\n` +
    `  every listed id MUST appear as a top-level <section id="..."> in index.html.\n\n` +
    `Requirements:\n` +
    `- Follow the DESIGN SYSTEM exactly. No Bootstrap, no Tailwind, no CSS frameworks.\n` +
    `- Output RENDERED HTML directly — NOT TypeScript functions that generate HTML.\n` +
    `- Absolutely NO package.json, NO node_modules, NO bundler, NO test framework.\n` +
    `- No external JS dependencies. CSS may use the system font stack.\n` +
    `- Image placeholders: choose the source based on what the image is FOR.\n` +
    `  - PHOTOGRAPHIC content (hero photography, hospitality, lifestyle, product\n` +
    `    shots, food, people, places, anything that would be a real photo on the\n` +
    `    finished site): use Lorem Picsum with a descriptive seed so every render\n` +
    `    is deterministic — e.g. \`https://picsum.photos/seed/tideline-hero/1200/800\`,\n` +
    `    \`https://picsum.photos/seed/garden-suite/800/1000\`. Seed slugs should\n` +
    `    describe the image (kebab-case). NEVER use placehold.co for photographic\n` +
    `    placeholders — grey text-on-grey rectangles destroy the polish of a\n` +
    `    brand-storytelling site and will look unfinished to the operator.\n` +
    `  - DIAGRAMS / charts / abstract blocks where a real photo wouldn't apply\n` +
    `    (architecture diagrams, dashboard screenshots, logo lockups): use\n` +
    `    \`https://placehold.co/\` with a colour scheme that matches the brand palette.\n` +
    `  - If unsure, default to picsum.photos — real photography always reads better\n` +
    `    than \"Tideline+Hotel\" written on a grey rectangle.\n` +
    `- index.html must be self-contained and open directly in a browser.\n` +
    `- Every <link href> and <script src> MUST point to a file you actually emit in this output.\n\n` +
    `Output format (exact — every file as its own block, no nesting):\n` +
    `--- FILE: index.html ---\n` +
    `[full HTML content here]\n` +
    `--- END FILE ---\n` +
    `--- FILE: styles.css ---\n` +
    `[full CSS content here]\n` +
    `--- END FILE ---\n` +
    `(... etc for each file)\n\n` +
    `Do NOT respond conversationally. Do NOT describe what you wrote. ` +
    `Do NOT use \`landing/index.html\` or any subdirectory path — root paths only.`;

// ── Snapshot of the inline `basePrompt` from implementStaticHtmlFeature (forge.ts:1235-1282) ──
const INLINE_IMPLEMENT_FEATURE_PROMPT =
    `Implement the following feature for a pure static HTML site.\n\n` +
    `Feature: ${SAMPLE_TITLE}\n` +
    `Details: ${SAMPLE_DESCRIPTION}\n\n` +
    `Rules:\n` +
    `- Follow the DESIGN DISCIPLINE in the context above (spacing, type, hairline\n` +
    `  borders, no shadows). Keep colours and fonts consistent with what styles.css\n` +
    `  already established for this project from the project brief — do NOT switch\n` +
    `  to KageOps moss-green tokens. No Bootstrap, no Tailwind, no CSS frameworks.\n` +
    `- Create .html, .css, and .js files directly — output RENDERED HTML, not TypeScript functions.\n` +
    `- File paths MUST be at the project ROOT — \`index.html\` not \`landing/index.html\`,\n` +
    `  \`styles.css\` not \`src/styles.css\`. No subdirectories.\n` +
    `- For multi-page sites, create separate .html files at the root\n` +
    `  (e.g., index.html, about.html, tips.html).\n` +
    `- Each .html page must include a consistent navigation bar linking to all other pages.\n` +
    `- Use a shared styles.css linked from every page.\n` +
    `- Image placeholders: choose the source based on what the image is FOR.\n` +
    `  - PHOTOGRAPHIC content (hero photography, hospitality, lifestyle, product\n` +
    `    shots, food, people, places, anything that would be a real photo on the\n` +
    `    finished site): use Lorem Picsum with a descriptive seed so every render\n` +
    `    is deterministic — e.g. \`https://picsum.photos/seed/tideline-hero/1200/800\`,\n` +
    `    \`https://picsum.photos/seed/garden-suite/800/1000\`. Seed slugs should\n` +
    `    describe the image (kebab-case). NEVER use placehold.co for photographic\n` +
    `    placeholders — grey text-on-grey rectangles destroy the polish of a\n` +
    `    brand-storytelling site and will look unfinished to the operator.\n` +
    `  - DIAGRAMS / charts / abstract blocks where a real photo wouldn't apply\n` +
    `    (architecture diagrams, dashboard screenshots, logo lockups): use\n` +
    `    \`https://placehold.co/\` with a colour scheme that matches the brand palette.\n` +
    `  - If unsure, default to picsum.photos — real photography always reads better\n` +
    `    than \"Tideline+Hotel\" written on a grey rectangle.\n` +
    `- No package.json. No npm. No build step. No test framework. No bundler.\n` +
    `- Use vanilla ES2022 JS, no modules, no imports. Always null-guard DOM lookups.\n` +
    `- Preserve existing content: return FULL contents of any file you modify.\n` +
    `- Every <link href> and <script src> MUST resolve to a file you emit or that already exists.\n` +
    `- styles.css MUST be balanced (every \`{\` has a matching \`}\`) — do not truncate.\n` +
    `- CSS COMPLETENESS (NON-NEGOTIABLE): for EVERY \`class="..."\` value you add or change in\n` +
    `  HTML, styles.css MUST contain a matching \`.<className> { ... }\` rule using the locked\n` +
    `  design tokens. If you introduce a new class name, you MUST also re-emit styles.css with\n` +
    `  that rule in the same response. A page with orphan classes fails acceptance.\n\n` +
    `STRUCTURAL CONTENT (NON-NEGOTIABLE):\n` +
    `- Read the Details above CAREFULLY. Use the EXACT section IDs, headlines, and components\n` +
    `  it specifies. Do NOT substitute generic SaaS sections like #features / #pricing / #faq\n` +
    `  unless the description explicitly says so.\n\n` +
    `Output format (exact):\n` +
    `--- FILE: index.html ---\n` +
    `[file content]\n` +
    `--- END FILE ---\n\n` +
    `Do NOT respond conversationally. Do NOT describe what you wrote.`;

// ── Tests ──

describe('vanilla-html bundle — manifest + presence', () => {
    it('loads cleanly from the real bundles/ directory', async () => {
        const result = await loadBundles(BUNDLES_ROOT);
        expect(result.errors).toEqual([]);
        const registry = new BundleRegistry(result);
        expect(registry.has('stack', 'vanilla-html')).toBe(true);
    });

    it('declares match phrases that include "vanilla html" and "static html"', async () => {
        const result = await loadBundles(BUNDLES_ROOT);
        const registry = new BundleRegistry(result);
        const bundle = registry.get('stack', 'vanilla-html');
        expect(bundle).toBeDefined();
        expect(bundle?.manifest.match?.phrases).toContain('vanilla html');
        expect(bundle?.manifest.match?.phrases).toContain('static html');
    });

    it('declares build.skip_npm true (no npm install for static sites)', async () => {
        const result = await loadBundles(BUNDLES_ROOT);
        const registry = new BundleRegistry(result);
        const bundle = registry.get('stack', 'vanilla-html');
        expect(bundle?.manifest.build?.skip_npm).toBe(true);
        expect(bundle?.manifest.build?.framework_label).toBe('Static HTML');
    });
});

describe('vanilla-html bundle — equivalence with inline Forge prompts', () => {
    it('forge_create_ui renders identically to inline setupStaticHtmlProject', async () => {
        const result = await loadBundles(BUNDLES_ROOT);
        const registry = new BundleRegistry(result);
        const bundle = registry.get('stack', 'vanilla-html');
        expect(bundle).toBeDefined();

        const rendered = await renderBundlePrompt(bundle!, {
            promptKey: 'forge_create_ui',
            vars: { title: SAMPLE_TITLE, description: SAMPLE_DESCRIPTION },
        });

        expect(rendered).toBe(INLINE_CREATE_UI_PROMPT);
    });

    it('forge_implement_feature renders identically to inline implementStaticHtmlFeature', async () => {
        const result = await loadBundles(BUNDLES_ROOT);
        const registry = new BundleRegistry(result);
        const bundle = registry.get('stack', 'vanilla-html');
        expect(bundle).toBeDefined();

        const rendered = await renderBundlePrompt(bundle!, {
            promptKey: 'forge_implement_feature',
            vars: { title: SAMPLE_TITLE, description: SAMPLE_DESCRIPTION },
        });

        expect(rendered).toBe(INLINE_IMPLEMENT_FEATURE_PROMPT);
    });
});
