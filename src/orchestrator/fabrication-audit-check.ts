/**
 * Fabrication audit (PR-5) — verification-time counterpart to G2 grounding.
 *
 * G2 (`src/agents/grounding.ts`) is a GENERATION-time directive: it tells the
 * content specialists to ground real-world facts in the brief and to SURFACE
 * GAPS (leave a visible `[TODO: confirm pricing]`) instead of inventing values.
 * That's prompt-only — nothing enforces it. This is the enforcement half: a
 * static scan of the produced, user-facing artifact for the objective "this
 * definitely should not ship" fabrication tells:
 *
 *   - lorem-ipsum         — placeholder latin shipped as real copy.
 *   - placeholder-contact — fake emails (`@example.com`), phones (`555-555-5555`,
 *                           `123-456-7890`), or addresses (`123 Main St`).
 *   - unfilled-placeholder — a surfaced gap that never got filled: `[TODO: …]`,
 *                           `[PLACEHOLDER]`, `YOUR_NAME_HERE`, `TODO_FROM_BRIEF`.
 *   - unreplaced-template  — a bundle `{{title}}`/`{{description}}` mustache var
 *                           the scaffold copier should have substituted.
 *
 * Deliberately NARROW: only tokens that are never legitimate in shipped UI, so
 * the false-positive rate stays near zero. The fuzzy fabrications (invented
 * testimonials, made-up statistics) are left to the G2 directive — a blocking
 * check on those would flag legitimate copy.
 *
 * Scans only RENDERED files (.html/.tsx/.jsx). Docs, examples, env templates,
 * and tests legitimately contain placeholders/example values, so they're
 * skipped — otherwise the scaffold's own SETUP.md / .env.example would trip it.
 *
 * Pure where possible; fs injected for the repo walk.
 */

import * as path from 'path';

export type FabricationCheck =
    | 'lorem-ipsum'
    | 'placeholder-contact'
    | 'unfilled-placeholder'
    | 'unreplaced-template';

export interface FabricationViolation {
    readonly check: FabricationCheck;
    /** Repo-relative path, forward-slashed (empty for the pure-string API). */
    readonly file: string;
    readonly snippet: string;
    readonly message: string;
}

// Only rendered, user-facing files. Docs/markdown/env/config legitimately hold
// example values, so they're out of scope.
const RENDERED_EXTS: ReadonlySet<string> = new Set(['.html', '.htm', '.tsx', '.jsx']);
const SKIP_DIRS: ReadonlySet<string> = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', '.vercel',
]);
const TEST_FILE_RE = /\.(test|spec|stories)\.[tj]sx?$/i;

interface Detector {
    readonly check: FabricationCheck;
    readonly re: RegExp;
    readonly describe: (m: string) => string;
}

const DETECTORS: readonly Detector[] = [
    {
        check: 'lorem-ipsum',
        re: /\blorem\s+ipsum\b/i,
        describe: () =>
            'Lorem-ipsum placeholder text shipped as real copy. Replace it with real content ' +
            'derived from the brief, or surface a visible gap for a human to fill.',
    },
    {
        check: 'placeholder-contact',
        re: /\b[a-z0-9._%+-]+@(?:example\.(?:com|org|net)|email\.com|domain\.com|yourdomain\.com|yoursite\.com)\b/i,
        describe: (m) =>
            `Placeholder email "${m}" shipped as a real contact. Use the real address from the ` +
            'brief, or surface a gap — never a fabricated one.',
    },
    {
        check: 'placeholder-contact',
        re: /\(?\b555\)?[-.\s]?555[-.\s]?5555\b|\b123[-.\s]?456[-.\s]?7890\b/,
        describe: (m) =>
            `Placeholder phone number "${m}" shipped as real. Use the brief's number or surface a gap.`,
    },
    {
        check: 'placeholder-contact',
        re: /\b(?:123\s+main|1234\s+elm|123\s+anywhere)\s+st(?:reet)?\b/i,
        describe: (m) =>
            `Placeholder street address "${m}" shipped as real. Use the brief's address or surface a gap.`,
    },
    {
        check: 'unfilled-placeholder',
        re: /\[(?:TODO|PLACEHOLDER|FIXME)\b[^\]]*\]|\bTODO_FROM_BRIEF\b|\b(?:YOUR|INSERT)[_ -](?:NAME|COMPANY|EMAIL|LOGO|TEXT|CONTENT|TITLE|ADDRESS)[_ -]HERE\b|\breplace\s+this\s+(?:text|content)\b/i,
        describe: (m) =>
            `Unfilled placeholder "${m}" shipped to the user. A surfaced gap is fine in development, ` +
            'but it must be resolved (filled from the brief or by a human) before deploy.',
    },
    {
        check: 'unreplaced-template',
        re: /\{\{\s*(?:title|description|name|appName|app_name)\s*\}\}/i,
        describe: (m) =>
            `Unreplaced template variable "${m}" — the scaffold copier substitutes these on copy, so ` +
            'one surviving in a rendered file means a broken substitution. Replace it with the real value.',
    },
];

/**
 * Pure core: scan a single file's content, returning one violation per distinct
 * detector that matches (first match wins per detector, to keep noise down).
 */
export function detectFabrication(content: string, file: string): readonly FabricationViolation[] {
    const out: FabricationViolation[] = [];
    for (const d of DETECTORS) {
        const m = d.re.exec(content);
        if (m !== null) {
            out.push({
                check: d.check,
                file,
                snippet: m[0],
                message: d.describe(m[0]),
            });
        }
    }
    return out;
}

/** Walk a repo's rendered files and run the fabrication detectors. */
export function scanRepoForFabrication(
    repoPath: string,
    fsImpl: typeof import('fs'),
): readonly FabricationViolation[] {
    const violations: FabricationViolation[] = [];

    const walk = (dir: string): void => {
        let entries: import('fs').Dirent[];
        try {
            entries = fsImpl.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(full);
            } else if (entry.isFile()) {
                if (TEST_FILE_RE.test(entry.name)) continue;
                if (!RENDERED_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
                let content: string;
                try {
                    content = fsImpl.readFileSync(full, 'utf-8');
                } catch {
                    continue;
                }
                const rel = path.relative(repoPath, full).replace(/\\/g, '/');
                violations.push(...detectFabrication(content, rel));
            }
        }
    };
    walk(repoPath);
    return violations;
}

/** Format violations into an operator-facing warning, or null if none. */
export function formatFabricationWarning(violations: readonly FabricationViolation[]): string | null {
    if (violations.length === 0) return null;
    const lines = violations.map((v) => `  - ${v.file} [${v.check}] — \`${v.snippet}\``);
    return (
        `Fabrication audit: ${violations.length} placeholder/fabricated value(s) in shipped UI.\n` +
        lines.join('\n')
    );
}
