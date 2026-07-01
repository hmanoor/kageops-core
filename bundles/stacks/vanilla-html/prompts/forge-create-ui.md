Set up a PURE STATIC HTML project — no Node, no npm, no build step, no test framework.

Title: {{title}}
Description: {{description}}

Generate EXACTLY these files at the project root (path strings must match exactly — no
subdirectories like `landing/` or `src/`):
1. `index.html` — at the project root. Semantic HTML5. References `styles.css` and `script.js`
   as siblings (`<link rel="stylesheet" href="styles.css">`, `<script src="script.js">`).
2. `styles.css` — at the project root. Full DESIGN SYSTEM implementation. Use the provided
   tokens.css SKELETON as the structure, but replace every `TODO_FROM_BRIEF` value with a
   colour you derive from the project description. The brief is authoritative: if it names
   colours (hex, named, or a reference site), use those verbatim. If the brief is
   colour-silent, fall back to a neutral monochrome (e.g. #0A0A0A bg / #FAFAFA light, warm
   grey #6B6B6B accent) — do NOT default to KageOps moss-green tokens. styles.css MUST NOT
   contain the literal string `TODO_FROM_BRIEF` in the output. Implement components using
   var(--accent) etc.
   Minimum 80 lines, every `{` matched by `}`. No truncation.
   CSS COMPLETENESS (NON-NEGOTIABLE): for EVERY `class="..."` value you put in index.html,
   styles.css MUST contain a matching `.<className> { ... }` rule. After you draft the HTML,
   list every distinct class name you used and add a rule for each one before you emit
   styles.css. A page that references `.sigil-card` or `.phase-item` without those rules
   defined will fail acceptance and you will be asked to redo it.
   F-371: CSS MUST live in styles.css — NOT inlined as a giant <style> block inside
   index.html. Even when the design system is large, emit a separate FILE block for
   styles.css. Vigil will reject any index.html whose inline <style> exceeds 40 lines
   when a separate styles.css could have been written instead.
3. `script.js` — at the project root. Vanilla ES2022, no modules, no imports. Always
   null-guard DOM lookups: `document.querySelector('.x')?.addEventListener(...)`.
4. `README.md` — at the project root. How to open (`npx serve .` or double-click).
5. If the description mentions MULTIPLE PAGES, additional .html files at the root only,
   never inside a subdirectory.

STRUCTURAL CONTENT (NON-NEGOTIABLE):
- Read the description above CAREFULLY. Use the EXACT section IDs, headlines, and components
  it specifies. Do NOT substitute generic SaaS sections like #features / #pricing / #faq
  unless the description explicitly says so.
- If the description lists required <section id="..."> values (e.g. #top, #agents, #how),
  every listed id MUST appear as a top-level <section id="..."> in index.html.

Requirements:
- Follow the DESIGN SYSTEM exactly. No Bootstrap, no Tailwind, no CSS frameworks.
- Output RENDERED HTML directly — NOT TypeScript functions that generate HTML.
- Absolutely NO package.json, NO node_modules, NO bundler, NO test framework.
- No external JS dependencies. CSS may use the system font stack.
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
- index.html must be self-contained and open directly in a browser.
- Every <link href> and <script src> MUST point to a file you actually emit in this output.

Output format (exact — every file as its own block, no nesting):
--- FILE: index.html ---
[full HTML content here]
--- END FILE ---
--- FILE: styles.css ---
[full CSS content here]
--- END FILE ---
(... etc for each file)

Do NOT respond conversationally. Do NOT describe what you wrote. Do NOT use `landing/index.html` or any subdirectory path — root paths only.
