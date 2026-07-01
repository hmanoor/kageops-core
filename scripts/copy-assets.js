/**
 * copy-assets.js — Build step: copy static assets to dist/
 *
 * Copies: command-center HTML/CSS and local fonts.
 *
 * Note: agent portraits are no longer copied — Wave 2 visual pivot replaced
 * raster portraits with inline sigil SVGs (see src/renderer/command-center/sigils.ts).
 */
const fs = require('fs');
const path = require('path');

function copyDir(src, dst, filter) {
    if (!fs.existsSync(src)) return; // tolerate optional/absent renderer dirs
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
        if (filter && !filter(f)) continue;
        fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
}

// 1. Command Center HTML + CSS
copyDir(
    path.join('src', 'renderer', 'command-center'),
    path.join('dist', 'renderer', 'command-center'),
    (f) => /\.(html|css)$/.test(f)
);

// 3. Plan selection window HTML + CSS
copyDir(
    path.join('src', 'renderer', 'plan'),
    path.join('dist', 'renderer', 'plan'),
    (f) => /\.(html|css)$/.test(f)
);

// 4. Welcome / onboarding window HTML + CSS
copyDir(
    path.join('src', 'renderer', 'welcome'),
    path.join('dist', 'renderer', 'welcome'),
    (f) => /\.(html|css)$/.test(f)
);

// 3b. Splash window HTML + CSS (boot animation)
copyDir(
    path.join('src', 'renderer', 'splash'),
    path.join('dist', 'renderer', 'splash'),
    (f) => /\.(html|css)$/.test(f)
);

// 5. Schema + seed SQL files → dist/db/
//    tsc only emits .ts → .js; .sql files in src/db must be copied
//    explicitly so initDatabase() can find them inside the packaged
//    asar archive. Without this, every fresh install (or post-wipe
//    rebuild) fails with 'SQL file not found' after PGlite initdb runs.
copyDir(
    path.join('src', 'db'),
    path.join('dist', 'db'),
    (f) => /\.sql$/.test(f)
);

// 2. Local woff2 fonts → dist/renderer/command-center/fonts/
//    Referenced by @font-face rules in tokens.css. Kept next to the CSS
//    (relative `url('fonts/…woff2')`) so same-origin font-src is enough.
const fontSrc = path.join('assets', 'fonts');
const fontDst = path.join('dist', 'renderer', 'command-center', 'fonts');
if (fs.existsSync(fontSrc)) {
    copyDir(fontSrc, fontDst, (f) => /\.woff2$/.test(f));
    console.log(`  Copied ${fs.readdirSync(fontDst).length} font files → dist/`);
}

console.log('  Assets copied successfully.');
