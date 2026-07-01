/**
 * Source-level HTML-id acceptance check (BPF-33).
 *
 * The brief can require specific element ids ("the landing page MUST contain
 * #hero, #pricing, #join-cta, #signin-link, #footer"). For a static-HTML bundle
 * the legacy `html-ids` acceptance path checks them against `index.html`. But
 * the nextjs-saas bundle uses the `build-tests-preview` acceptance kind, whose
 * only artifact check is HTTP-200 on preview routes — it NEVER verifies the
 * required ids. And run-locally (no preview URL) the gate was skipped entirely.
 *
 * Net effect (the ClubHubOSS6 bug): a run-locally Next.js project could
 * "complete" with the STOCK scaffold landing page — none of the required ids
 * present — because nothing ever checked them. This module closes that: scan
 * the App-Router source (`app/`, `src/`, `components/`) for each required id as
 * a JSX/HTML attribute, so acceptance enforces the brief even with no preview.
 *
 * Pure (fs injected). Matches `id="x"`, `id='x'`, and `id={'x'}` / `id={"x"}`.
 */

import * as path from 'path';

export interface HtmlIdSourceViolation {
    readonly check: 'missing-id';
    readonly expected: string;
    readonly message: string;
}

const SOURCE_EXTS: ReadonlySet<string> = new Set(['.tsx', '.jsx', '.ts', '.js', '.html', '.htm', '.mdx']);
const SKIP_DIRS: ReadonlySet<string> = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', '.vercel', 'tests', 'test', '__tests__',
]);
const MAX_FILES = 1000;

function dirExists(repoPath: string, rel: string, fsImpl: typeof import('fs')): boolean {
    try {
        return fsImpl.statSync(path.join(repoPath, rel)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * The App Router directory Next.js actually renders. Next prefers a root `app/`
 * over `src/app/` when BOTH exist (the ClubHubOSS6 dual-dir trap: Forge wrote
 * the real page to `src/app/page.tsx` while the stock `app/page.tsx` shadowed
 * it). Returns null for a non-App-Router project. Exported for tests.
 */
export function resolveActiveAppDir(repoPath: string, fsImpl: typeof import('fs')): string | null {
    if (dirExists(repoPath, 'app', fsImpl)) return 'app';
    if (dirExists(repoPath, 'src/app', fsImpl)) return 'src/app';
    return null;
}

/**
 * UI roots to scan, scoped to the ACTIVE app dir so ids sitting in a dead/
 * shadowed `src/app` (or `app`) don't count. Includes shared component/lib dirs
 * the active page can import from.
 */
function uiRootsFor(repoPath: string, fsImpl: typeof import('fs')): readonly string[] {
    const active = resolveActiveAppDir(repoPath, fsImpl);
    const roots = active !== null
        ? [active, 'components', 'src/components', 'lib', 'src/lib', 'pages']
        : ['components', 'pages']; // static / non-App-Router → root files via fallback below
    return roots;
}

/** Escape a string for use as a literal inside a RegExp. */
function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `corpus` contain `id="<id>"` (single/double/brace-quoted)? */
export function corpusHasId(corpus: string, id: string): boolean {
    const e = escapeRe(id);
    // id = "x" | 'x' | {"x"} | {'x'}  — tolerate whitespace
    const re = new RegExp(`\\bid\\s*=\\s*\\{?\\s*["'\\\`]${e}["'\\\`]`);
    return re.test(corpus);
}

/** Read every UI source file under the repo into one corpus string. */
export function readUiSourceCorpus(repoPath: string, fsImpl: typeof import('fs')): string {
    const parts: string[] = [];
    let count = 0;

    const walk = (dir: string): void => {
        if (count >= MAX_FILES) return;
        let entries: import('fs').Dirent[];
        try {
            entries = fsImpl.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (count >= MAX_FILES) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(full);
            } else if (entry.isFile()) {
                if (!SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
                if (/\.(test|spec)\.[tj]sx?$/.test(entry.name)) continue;
                try {
                    parts.push(fsImpl.readFileSync(full, 'utf-8'));
                    count++;
                } catch {
                    /* unreadable — skip */
                }
            }
        }
    };

    for (const root of uiRootsFor(repoPath, fsImpl)) {
        walk(path.join(repoPath, root));
    }
    // Static / non-App-Router projects keep their UI at the repo root.
    if (resolveActiveAppDir(repoPath, fsImpl) === null) {
        walk(repoPath);
    }
    return parts.join('\n');
}

/**
 * Return a `missing-id` violation for every required id NOT found as an
 * id attribute anywhere in the UI source. Empty when all are present (or none
 * required). Never throws.
 */
export function checkHtmlIdsInSource(
    repoPath: string,
    requiredIds: readonly string[],
    fsImpl: typeof import('fs'),
): readonly HtmlIdSourceViolation[] {
    if (requiredIds.length === 0) return [];
    const corpus = readUiSourceCorpus(repoPath, fsImpl);
    const violations: HtmlIdSourceViolation[] = [];
    for (const id of requiredIds) {
        if (!corpusHasId(corpus, id)) {
            violations.push({
                check: 'missing-id',
                expected: `an element with id="${id}" in the app source`,
                message:
                    `The brief requires an element with id="${id}" but no \`id="${id}"\` was found in the ` +
                    `app/ source. The landing page may still be the unmodified scaffold or the id was dropped.`,
            });
        }
    }
    return violations;
}
