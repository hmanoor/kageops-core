/**
 * Deploy-readiness check — module-load-time SDK initialization (G5).
 *
 * A generated app shipped `new Stripe(process.env.STRIPE_SECRET_KEY!)` (and a
 * Drizzle/Neon client) at MODULE TOP LEVEL. `next build` evaluates module
 * top-level code during page-data collection, with NO runtime secrets present
 * (Vercel applies env at runtime, not build time). So the eager construction
 * crashed `next build` on a secret-less host even though the app was correct
 * at runtime.
 *
 * This module statically flags that pattern: a construction that runs at import
 * time AND reads `process.env`. The fix is always the same — defer it behind a
 * function (`getStripe()` / `getDb()`) that constructs on first call.
 *
 * Heuristic, not a type-checker: we report it as a WARNING (surfaced in the
 * build log + an event) rather than failing the gate, mirroring
 * route-collision-check. The build step itself is the hard gate. The check's
 * value is naming the root cause for the secret-PRESENT local build that passes
 * but would crash on Vercel.
 *
 * Pure module (fs injected) — easy to unit test.
 */

import * as path from 'path';

export interface ModuleLoadInitFinding {
    /** Repo-relative path, forward-slashed. */
    readonly file: string;
    /** 1-based line number of the offending construction. */
    readonly line: number;
    /** The constructor / factory name (e.g. 'Stripe', 'neon'). */
    readonly ctor: string;
    /** The trimmed source line, for the warning message. */
    readonly snippet: string;
}

// Factory-style initializers (not `new`) that build a client from env at
// import. `new <Cap>(...)` is matched generically; these named calls catch the
// common non-`new` SDK factories.
const KNOWN_FACTORIES: readonly string[] = [
    'neon',
    'postgres',
    'createClient',
    'createPool',
    'connect',
    'drizzle',
] as const;

const SOURCE_EXTS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;
const SKIP_DIRS: ReadonlySet<string> = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', '.vercel',
]);

/**
 * Replace the contents of string literals and comments with spaces (preserving
 * length and newlines) so brace-depth counting and pattern matching don't trip
 * on `{`/`}`/`new` inside strings or comments.
 */
export function stripStringsAndComments(source: string): string {
    let out = '';
    let i = 0;
    const n = source.length;
    type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
    let mode: Mode = 'code';

    while (i < n) {
        const c = source[i];
        const next = i + 1 < n ? source[i + 1] : '';

        if (mode === 'code') {
            if (c === '/' && next === '/') { out += '  '; i += 2; mode = 'line'; continue; }
            if (c === '/' && next === '*') { out += '  '; i += 2; mode = 'block'; continue; }
            if (c === "'") { out += ' '; i += 1; mode = 'single'; continue; }
            if (c === '"') { out += ' '; i += 1; mode = 'double'; continue; }
            if (c === '`') { out += ' '; i += 1; mode = 'template'; continue; }
            out += c; i += 1; continue;
        }
        if (mode === 'line') {
            if (c === '\n') { out += '\n'; i += 1; mode = 'code'; continue; }
            out += ' '; i += 1; continue;
        }
        if (mode === 'block') {
            if (c === '*' && next === '/') { out += '  '; i += 2; mode = 'code'; continue; }
            out += c === '\n' ? '\n' : ' '; i += 1; continue;
        }
        // string modes — handle escapes; preserve newlines
        const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
        if (c === '\\') { out += '  '; i += 2; continue; }
        if (c === closer) { out += ' '; i += 1; mode = 'code'; continue; }
        out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    return out;
}

/**
 * Scan a single source file's contents for module-scope initializers that read
 * `process.env`. Returns one finding per offending construction.
 */
export function detectModuleLoadInit(source: string, file: string): readonly ModuleLoadInitFinding[] {
    const stripped = stripStringsAndComments(source);
    const findings: ModuleLoadInitFinding[] = [];

    const factoryAlt = KNOWN_FACTORIES.join('|');
    // `new Stripe(`  or  `neon(` / `drizzle(` etc.
    const ctorRe = new RegExp(`\\bnew\\s+([A-Z][A-Za-z0-9_]*)\\s*\\(|\\b(${factoryAlt})\\s*\\(`, 'g');

    let m: RegExpExecArray | null;
    while ((m = ctorRe.exec(stripped)) !== null) {
        const idx = m.index;
        // Module scope only: zero unclosed `{` before this point.
        if (braceDepthAt(stripped, idx) !== 0) continue;

        // Must read env at import time — check the enclosing statement (this
        // line plus its continuation up to the matching close paren / line end).
        const stmt = enclosingStatement(stripped, idx);
        if (!/process\.env\b/.test(stmt)) continue;

        const ctorName = m[1] ?? m[2] ?? '';
        const line = lineNumberAt(source, idx);
        const snippet = sourceLineAt(source, line).trim();
        findings.push({ file, line, ctor: ctorName, snippet });
    }
    return findings;
}

/** Walk a repo and run the detector on every source file. */
export function scanRepoForModuleLoadInit(
    repoPath: string,
    fsImpl: typeof import('fs'),
): readonly ModuleLoadInitFinding[] {
    const findings: ModuleLoadInitFinding[] = [];

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
                const ext = path.extname(entry.name).toLowerCase();
                if (!SOURCE_EXTS.includes(ext)) continue;
                if (/\.(test|spec)\.[tj]sx?$/.test(entry.name)) continue;
                let content: string;
                try {
                    content = fsImpl.readFileSync(full, 'utf-8');
                } catch {
                    continue;
                }
                const rel = path.relative(repoPath, full).replace(/\\/g, '/');
                findings.push(...detectModuleLoadInit(content, rel));
            }
        }
    };
    walk(repoPath);
    return findings;
}

/** Format findings into an operator-facing warning, or null if none. */
export function formatModuleLoadInitWarning(
    findings: readonly ModuleLoadInitFinding[],
): string | null {
    if (findings.length === 0) return null;
    const lines = findings.map(
        (f) => `  - ${f.file}:${f.line} — \`${f.snippet}\` constructs \`${f.ctor}\` at module load`,
    );
    return (
        `Deploy-readiness: ${findings.length} module-load-time initializer(s) read process.env at import.\n` +
        `\`next build\` evaluates module top-level code with NO secrets present, so these crash the\n` +
        `build on a secret-less host (e.g. Vercel). Defer each behind a function that constructs on\n` +
        `first call — see lib/stripe.ts \`getStripe()\` / lib/db \`getDb()\`:\n` +
        lines.join('\n')
    );
}

// ── helpers ──────────────────────────────────────────

function braceDepthAt(stripped: string, idx: number): number {
    let depth = 0;
    for (let i = 0; i < idx; i++) {
        const c = stripped[i];
        if (c === '{') depth++;
        else if (c === '}') depth = Math.max(0, depth - 1);
    }
    return depth;
}

/** Substring from the start of the construction to the end of its line or the
 * balanced close paren, whichever comes later — enough to see `process.env`. */
function enclosingStatement(stripped: string, idx: number): string {
    // back up to the start of the line
    let start = idx;
    while (start > 0 && stripped[start - 1] !== '\n') start--;
    // forward to the matching close paren of the construction, then to line end
    let depth = 0;
    let i = idx;
    let seenOpen = false;
    for (; i < stripped.length; i++) {
        const c = stripped[i];
        if (c === '(') { depth++; seenOpen = true; }
        else if (c === ')') { depth--; if (seenOpen && depth === 0) { i++; break; } }
        else if (c === '\n' && !seenOpen) break;
    }
    // extend to end of the line containing i
    while (i < stripped.length && stripped[i] !== '\n') i++;
    return stripped.slice(start, i);
}

function lineNumberAt(source: string, idx: number): number {
    let line = 1;
    for (let i = 0; i < idx && i < source.length; i++) {
        if (source[i] === '\n') line++;
    }
    return line;
}

function sourceLineAt(source: string, line: number): string {
    const lines = source.split('\n');
    return lines[line - 1] ?? '';
}
