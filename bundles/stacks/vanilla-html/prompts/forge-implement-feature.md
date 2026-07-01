Implement the following feature for a pure static HTML site.

Feature: {{title}}
Details: {{description}}

Rules:
- Follow the DESIGN DISCIPLINE in the context above (spacing, type, hairline
  borders, no shadows). Keep colours and fonts consistent with what styles.css
  already established for this project from the project brief — do NOT switch
  to KageOps moss-green tokens. No Bootstrap, no Tailwind, no CSS frameworks.
- Create .html, .css, and .js files directly — output RENDERED HTML, not TypeScript functions.
- File paths MUST be at the project ROOT — `index.html` not `landing/index.html`,
  `styles.css` not `src/styles.css`. No subdirectories.
- For multi-page sites, create separate .html files at the root
  (e.g., index.html, about.html, tips.html).
- Each .html page must include a consistent navigation bar linking to all other pages.
- Use a shared styles.css linked from every page.
- Image placeholders: choose the source based on what the image is FOR.
  - PHOTOGRAPHIC content (hero photography, hospitality, lifestyle, product
    shots, food, people, places, anything that would be a real photo on the
    finished site): use Lorem Picsum with a descriptive seed so every render
    is deterministic — e.g. `https://picsum.photos/seed/tideline-hero/1200/800`,
    `https://picsum.photos/seed/garden-suite/800/1000`. Seed slugs should
    describe the image (kebab-case). NEVER use placehold.co for photographic
    placeholders — grey text-on-grey rectangles destroy the polish of a
    brand-storytelling site and will look unfinished to the operator.
  - DIAGRAMS / charts / abstract blocks where a real photo wouldn't apply
    (architecture diagrams, dashboard screenshots, logo lockups): use
    `https://placehold.co/` with a colour scheme that matches the brand palette.
  - If unsure, default to picsum.photos — real photography always reads better
    than "Tideline+Hotel" written on a grey rectangle.
- No package.json. No npm. No build step. No test framework. No bundler.
- Use vanilla ES2022 JS, no modules, no imports. Always null-guard DOM lookups.
- Preserve existing content: return FULL contents of any file you modify.
- Every <link href> and <script src> MUST resolve to a file you emit or that already exists.
- styles.css MUST be balanced (every `{` has a matching `}`) — do not truncate.
- CSS COMPLETENESS (NON-NEGOTIABLE): for EVERY `class="..."` value you add or change in
  HTML, styles.css MUST contain a matching `.<className> { ... }` rule using the locked
  design tokens. If you introduce a new class name, you MUST also re-emit styles.css with
  that rule in the same response. A page with orphan classes fails acceptance.

STRUCTURAL CONTENT (NON-NEGOTIABLE):
- Read the Details above CAREFULLY. Use the EXACT section IDs, headlines, and components
  it specifies. Do NOT substitute generic SaaS sections like #features / #pricing / #faq
  unless the description explicitly says so.

Output format (exact):
--- FILE: index.html ---
[file content]
--- END FILE ---

Do NOT respond conversationally. Do NOT describe what you wrote.
