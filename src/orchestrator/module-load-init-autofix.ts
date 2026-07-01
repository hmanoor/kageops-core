/**
 * Deploy-readiness AUTO-FIX — defer module-load-time SDK initializers (G5 / BPF-27).
 *
 * Companion to `module-load-init-check.ts`. The detector flags a construction
 * that runs at import AND reads `process.env` (e.g. a route file doing
 * `export const db = drizzle(neon(process.env.DATABASE_URL!));`). On a weak/OSS
 * model the build-fix loop often can't apply the fix even though the error text
 * spells it out — so the harness absorbs the defect deterministically here,
 * mirroring the BPF-26 migration-baseline fix.
 *
 * The rewrite is the SAME shape the scaffold's `lib/db/index.ts` already proves
 * compiles under `strict`: move the eager initializer behind a function body
 * (so it runs on first use, not at import) and expose the binding through a
 * lazy `Proxy` so every existing `db.xxx` / `client.xxx` call site keeps working
 * untouched. Wrapping the initializer in a `{ ... }` body also makes it
 * invisible to the detector (which only flags brace-depth-0 constructions), so a
 * re-scan after the rewrite comes back clean.
 *
 * Conservative by design — HIGH PRECISION over recall:
 *   - Only a single-declarator module-scope `(export) const NAME = <init>;` whose
 *     initializer is a direct construction/call (NOT a function/arrow value) and
 *     reads `process.env` is rewritten. Anything else is left for the build-fix
 *     loop / a human.
 *   - A file's rewrite is kept ONLY if a re-scan shows strictly fewer findings;
 *     otherwise it is discarded (we are never worse than doing nothing).
 *   - Any parse/IO error on a file → skip that file. The gate then blocks as
 *     before, so worst case equals today's behaviour.
 *
 * Pure where possible (fs injected); the per-file transform is a pure string fn.
 */

import * as path from 'path';

import {
    stripStringsAndComments,
    detectModuleLoadInit,
    scanRepoForModuleLoadInit,
    type ModuleLoadInitFinding,
} from './module-load-init-check';

const SOURCE_EXTS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;
const SKIP_DIRS: ReadonlySet<string> = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', '.vercel',
]);

// Backstop so a pathological file can never trigger an unbounded rewrite loop.
const MAX_REWRITES_PER_FILE = 20;

// A flagged construction inside the initializer: `new Cap(` or a known factory.
const FACTORY_ALT = 'neon|postgres|createClient|createPool|connect|drizzle';
const CTOR_IN_INIT_RE = new RegExp(`\\bnew\\s+[A-Z][A-Za-z0-9_]*\\s*\\(|\\b(?:${FACTORY_ALT})\\s*\\(`);

// Marker prefix for generated identifiers — also used for idempotency.
const GEN_PREFIX = '__kageopsLazyInit_';

interface DeclMatch {
    /** Offset of the `export`/`const` keyword in the source. */
    readonly start: number;
    /** Offset just past the terminating `;` (or the ASI newline). */
    readonly end: number;
    readonly name: string;
    /** The initializer expression text, trimmed, no trailing `;`. */
    readonly init: string;
    readonly exported: boolean;
}

/**
 * Rewrite the safe-shaped eager initializers in one file's source. Returns the
 * new source, or `null` when nothing was safely rewritten OR the rewrite did not
 * strictly reduce the detector's findings (in which case it is discarded).
 */
export function deferModuleLoadInit(source: string, file: string): string | null {
    const before = detectModuleLoadInit(source, file);
    if (before.length === 0) return null;

    // Idempotency: never re-process our own output.
    if (source.includes(GEN_PREFIX)) return null;

    const matches = findRewritableDecls(source);
    if (matches.length === 0) return null;

    // Splice from last to first so earlier offsets stay valid.
    let out = source;
    for (let i = matches.length - 1; i >= 0; i--) {
        const d = matches[i];
        out = out.slice(0, d.start) + buildLazyReplacement(d) + out.slice(d.end);
    }

    // Keep only if it strictly improved (defensive against a malformed splice).
    const after = detectModuleLoadInit(out, file);
    if (after.length >= before.length) return null;
    return out;
}

/**
 * Walk a repo, defer eager initializers in every source file, write fixed files
 * back, and report what changed. Never throws on a single-file failure.
 */
export function autofixRepoModuleLoadInit(
    repoPath: string,
    fsImpl: typeof import('fs'),
): { readonly filesFixed: readonly string[]; readonly remaining: readonly ModuleLoadInitFinding[] } {
    const filesFixed: string[] = [];

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
                continue;
            }
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (!SOURCE_EXTS.includes(ext)) continue;
            if (/\.(test|spec)\.[tj]sx?$/.test(entry.name)) continue;

            const rel = path.relative(repoPath, full).replace(/\\/g, '/');
            try {
                const content = fsImpl.readFileSync(full, 'utf-8');
                const fixed = deferModuleLoadInit(content, rel);
                if (fixed !== null && fixed !== content) {
                    fsImpl.writeFileSync(full, fixed, 'utf-8');
                    filesFixed.push(rel);
                }
            } catch {
                // Unreadable/unwritable or transform error — leave it for the gate.
            }
        }
    };
    walk(repoPath);

    // Re-scan so the caller knows what (if anything) still blocks.
    let remaining: readonly ModuleLoadInitFinding[] = [];
    try {
        remaining = scanRepoForModuleLoadInit(repoPath, fsImpl);
    } catch {
        remaining = [];
    }
    return { filesFixed, remaining };
}

// ── declaration discovery ────────────────────────────

/**
 * Find module-scope `(export) const NAME = <init>;` declarations whose
 * initializer is a direct construction reading `process.env` — the only shape
 * we rewrite. Offsets index into the ORIGINAL source (strip preserves length).
 */
function findRewritableDecls(source: string): readonly DeclMatch[] {
    const stripped = stripStringsAndComments(source);
    const out: DeclMatch[] = [];

    const declRe = /\b(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{}]+)?=\s*/g;
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(stripped)) !== null && out.length < MAX_REWRITES_PER_FILE) {
        const start = m.index;
        if (braceDepthAt(stripped, start) !== 0) continue; // module scope only

        const name = m[2];
        if (name.startsWith(GEN_PREFIX)) continue; // idempotency

        const initStart = m.index + m[0].length;
        const span = statementEnd(stripped, initStart);
        if (span === null) continue;

        const initStripped = stripped.slice(initStart, span.initEnd);
        // Must read env AND be a flagged construction…
        if (!/process\.env\b/.test(initStripped)) continue;
        if (!CTOR_IN_INIT_RE.test(initStripped)) continue;
        // …and NOT a function/arrow value (those are already lazy; wrapping them
        // in a value-Proxy would break calling them).
        if (/=>|\bfunction\b/.test(initStripped)) continue;
        // Single declarator only — a depth-0 comma means `const a = …, b = …`.
        if (hasTopLevelComma(initStripped)) continue;

        const init = source.slice(initStart, span.initEnd).trim();
        if (init.length === 0) continue;

        out.push({ start, end: span.end, name, init, exported: m[1] !== undefined });
    }
    return out;
}

/**
 * From the initializer start, find the end of the declaration: the first
 * depth-0 `;` (consumed) or a depth-0 newline after a balanced initializer
 * (ASI, not consumed). Returns null if brackets never balance.
 */
function statementEnd(stripped: string, from: number): { readonly initEnd: number; readonly end: number } | null {
    let depth = 0;
    for (let i = from; i < stripped.length; i++) {
        const c = stripped[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth < 0) return null;
        } else if (depth === 0) {
            if (c === ';') return { initEnd: i, end: i + 1 };
            if (c === '\n') {
                // ASI only once the initializer has real content on the way here.
                const seg = stripped.slice(from, i).trim();
                if (seg.length > 0) return { initEnd: i, end: i };
            }
        }
    }
    return null;
}

// ── replacement ──────────────────────────────────────

function buildLazyReplacement(d: DeclMatch): string {
    const initFn = `${GEN_PREFIX}${d.name}`;
    const cacheVar = `__kageopsLazyCache_${d.name}`;
    const exportKw = d.exported ? 'export ' : '';
    const ty = `ReturnType<typeof ${initFn}>`;
    // The initializer now lives inside a function BODY ({ ... }) so it runs on
    // first property access, not at import — and is invisible to the detector.
    return (
        `const ${initFn} = () => { return (${d.init}); };\n` +
        `let ${cacheVar}: ${ty} | undefined;\n` +
        `${exportKw}const ${d.name}: ${ty} = new Proxy({} as ${ty}, {\n` +
        `  get(_target, _prop, _receiver) {\n` +
        `    if (${cacheVar} === undefined) { ${cacheVar} = ${initFn}(); }\n` +
        `    const _value = Reflect.get(${cacheVar} as object, _prop, _receiver);\n` +
        `    return typeof _value === 'function' ? (_value as (...args: never[]) => unknown).bind(${cacheVar}) : _value;\n` +
        `  },\n` +
        `});`
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

function hasTopLevelComma(initStripped: string): boolean {
    let depth = 0;
    for (let i = 0; i < initStripped.length; i++) {
        const c = initStripped[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
        else if (c === ',' && depth === 0) return true;
    }
    return false;
}
