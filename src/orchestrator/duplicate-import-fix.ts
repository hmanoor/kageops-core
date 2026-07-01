/**
 * Duplicate-import dedup (BPF-17) — a deterministic pre-build source repair.
 *
 * Weak/OSS models frequently emit a file by concatenating several "blocks",
 * each re-importing what it needs — so the same import lands many times. The
 * ClubHubOSS run's first webhook route had `import { eq } from 'drizzle-orm';`
 * FIVE times. TypeScript rejects that ("Duplicate identifier 'eq'"), `next
 * build` fails, and the OSS build-fix loop can't reliably clean it up. Same
 * thesis as BPF-26/27: the harness absorbs the defect deterministically.
 *
 * Conservative — HIGH PRECISION over recall:
 *   - PURE named imports from the same module (`import { a, b } from 'm'`) are
 *     merged into ONE statement, unioning specifiers (first-seen order, deduped).
 *     Value and `import type` groups are kept separate so we never change a
 *     type-only import into a value import or vice-versa.
 *   - Every OTHER form (side-effect `import 'm'`, default, namespace `* as`,
 *     mixed `D, { x }`) is only de-duplicated when a statement is byte-identical
 *     to an earlier one — removing an exact-duplicate import is always a no-op
 *     except for fixing the duplicate-identifier error.
 *   - Only top-level (brace-depth 0) imports terminated by `;` are touched;
 *     anything we can't parse cleanly is left alone. A file is rewritten only if
 *     it actually changes.
 *
 * Pure per-file transform (fs injected for the repo walk).
 */

import * as path from 'path';

import { stripStringsAndComments } from './module-load-init-check';

const SOURCE_EXTS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;
const SKIP_DIRS: ReadonlySet<string> = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', '.vercel',
]);

interface ImportStmt {
    readonly start: number;
    readonly end: number; // index just past the terminating ';'
    readonly raw: string; // trimmed statement text
    readonly module: string | null;
    /** Pure named value import → its specifier list; else null. */
    readonly namedValueSpecs: readonly string[] | null;
    /** Pure named type-only import (`import type { … }`) → specs; else null. */
    readonly namedTypeSpecs: readonly string[] | null;
}

/** Rewrite a single file's duplicate imports, or null if nothing changed. */
export function dedupeImportsInSource(source: string): string | null {
    const stmts = findImportStatements(source);
    if (stmts.length < 2) return null;

    // Spans to remove (start,end) and replacements (start,end,text).
    const removals: Array<{ start: number; end: number; text?: string }> = [];

    // 1. Merge pure named imports per module (value + type groups separately).
    mergeNamedGroup(stmts, 'value', removals);
    mergeNamedGroup(stmts, 'type', removals);

    // 2. Exact-duplicate removal for everything not already handled above.
    const handled = new Set(removals.map((r) => r.start));
    const seen = new Set<string>();
    for (const s of stmts) {
        if (handled.has(s.start)) continue;
        if (seen.has(s.raw)) {
            removals.push({ start: s.start, end: s.end }); // pure removal
        } else {
            seen.add(s.raw);
        }
    }

    if (removals.length === 0) return null;

    // Apply last-to-first so offsets stay valid. A pure removal also swallows a
    // single trailing newline so we don't leave a blank line behind.
    removals.sort((a, b) => b.start - a.start);
    let out = source;
    for (const r of removals) {
        if (r.text !== undefined) {
            out = out.slice(0, r.start) + r.text + out.slice(r.end);
        } else {
            let end = r.end;
            if (out[end] === '\r') end++;
            if (out[end] === '\n') end++;
            out = out.slice(0, r.start) + out.slice(end);
        }
    }
    return out === source ? null : out;
}

/** Walk a repo, dedupe imports in every source file, write fixed files back. */
export function autofixRepoDuplicateImports(
    repoPath: string,
    fsImpl: typeof import('fs'),
): { readonly filesFixed: readonly string[] } {
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
            if (!SOURCE_EXTS.includes(path.extname(entry.name).toLowerCase())) continue;
            const rel = path.relative(repoPath, full).replace(/\\/g, '/');
            try {
                const content = fsImpl.readFileSync(full, 'utf-8');
                const fixed = dedupeImportsInSource(content);
                if (fixed !== null && fixed !== content) {
                    fsImpl.writeFileSync(full, fixed, 'utf-8');
                    filesFixed.push(rel);
                }
            } catch {
                // best-effort — a single bad file must not break the gate
            }
        }
    };
    walk(repoPath);
    return { filesFixed };
}

// ── parsing ──────────────────────────────────────────

function findImportStatements(source: string): readonly ImportStmt[] {
    const stripped = stripStringsAndComments(source);
    const out: ImportStmt[] = [];
    const re = /\bimport\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
        const start = m.index;
        if (braceDepthAt(stripped, start) !== 0) continue;
        // Must be a statement start (preceding non-space char is a boundary).
        const prev = lastNonSpace(stripped, start);
        if (prev !== '' && prev !== ';' && prev !== '}' && prev !== '{') continue;
        // import.meta / dynamic import( … ) are not import statements.
        const after = stripped.slice(start + 'import'.length).match(/^\s*[.(]/);
        if (after !== null) continue;

        const semi = stripped.indexOf(';', start);
        if (semi === -1) continue;
        // No other ';' may sit between — but an import has none until its end.
        const end = semi + 1;
        const raw = source.slice(start, end).trim();
        const parsed = parseImport(source.slice(start, end));
        out.push({ start, end, raw, ...parsed });
    }
    return out;
}

function parseImport(text: string): Pick<ImportStmt, 'module' | 'namedValueSpecs' | 'namedTypeSpecs'> {
    const fromMatch = text.match(/\bfrom\s*['"]([^'"]+)['"]\s*;?\s*$/);
    const module = fromMatch !== null ? fromMatch[1] : sideEffectModule(text);

    // Pure named: `import { … } from 'm'` (optionally `import type { … }`),
    // with NO default or namespace binding before the brace.
    const typeOnly = /^import\s+type\s*\{/.test(text);
    const valueNamed = /^import\s*\{/.test(text);
    if ((typeOnly || valueNamed) && fromMatch !== null) {
        const braceBody = text.slice(text.indexOf('{') + 1, text.lastIndexOf('}'));
        const specs = splitSpecifiers(braceBody);
        if (specs !== null) {
            return {
                module,
                namedValueSpecs: typeOnly ? null : specs,
                namedTypeSpecs: typeOnly ? specs : null,
            };
        }
    }
    return { module, namedValueSpecs: null, namedTypeSpecs: null };
}

function mergeNamedGroup(
    stmts: readonly ImportStmt[],
    kind: 'value' | 'type',
    removals: Array<{ start: number; end: number; text?: string }>,
): void {
    const pick = (s: ImportStmt): readonly string[] | null =>
        kind === 'value' ? s.namedValueSpecs : s.namedTypeSpecs;

    const byModule = new Map<string, ImportStmt[]>();
    for (const s of stmts) {
        if (s.module === null || pick(s) === null) continue;
        const list = byModule.get(s.module) ?? [];
        list.push(s);
        byModule.set(s.module, list);
    }

    for (const [module, group] of byModule) {
        const allSpecs: string[] = [];
        const seen = new Set<string>();
        for (const s of group) {
            for (const spec of pick(s) ?? []) {
                if (!seen.has(spec)) { seen.add(spec); allSpecs.push(spec); }
            }
        }
        // Need a rewrite only if multiple statements collapse, OR a single
        // statement carried duplicate specifiers.
        const totalRaw = group.reduce((n, s) => n + (pick(s)?.length ?? 0), 0);
        if (group.length < 2 && totalRaw === allSpecs.length) continue;

        const quote = group[0].raw.includes('"') ? '"' : "'";
        const kw = kind === 'type' ? 'import type ' : 'import ';
        const merged = `${kw}{ ${allSpecs.join(', ')} } from ${quote}${module}${quote};`;
        // First statement → merged text; the rest → removed.
        const [first, ...rest] = group;
        removals.push({ start: first.start, end: first.end, text: merged });
        for (const s of rest) removals.push({ start: s.start, end: s.end });
    }
}

// ── helpers ──────────────────────────────────────────

function splitSpecifiers(braceBody: string): readonly string[] | null {
    const out: string[] = [];
    for (const part of braceBody.split(',')) {
        const t = part.trim();
        if (t.length === 0) continue;
        // A nested brace means this isn't a flat specifier list — bail out.
        if (t.includes('{') || t.includes('}')) return null;
        out.push(t.replace(/\s+/g, ' '));
    }
    return out;
}

function sideEffectModule(text: string): string | null {
    const m = text.match(/^import\s*['"]([^'"]+)['"]\s*;?\s*$/);
    return m !== null ? m[1] : null;
}

function braceDepthAt(stripped: string, idx: number): number {
    let depth = 0;
    for (let i = 0; i < idx; i++) {
        const c = stripped[i];
        if (c === '{') depth++;
        else if (c === '}') depth = Math.max(0, depth - 1);
    }
    return depth;
}

function lastNonSpace(s: string, idx: number): string {
    for (let i = idx - 1; i >= 0; i--) {
        if (!/\s/.test(s[i])) return s[i];
    }
    return '';
}
