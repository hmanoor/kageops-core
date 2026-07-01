/**
 * Workspace content search (B-429).
 *
 * Ripgrep-style per-line scan over a single project's workspace. Runs in
 * the main process, filesystem-sandboxed to `project.repo_path` via
 * `resolveSafeWorkspacePath`. Skips excluded dirs/files and binaries,
 * caps per-file read size, and caps total matches.
 *
 * Kept separate from `ArtifactService` so the pure line-matching helpers
 * can be unit tested without touching disk.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
    EXCLUDE_DIRS,
    EXCLUDE_FILES,
    resolveSafeWorkspacePath,
    sniffBinary,
} from './artifact-service';

export interface SearchQueryOptions {
    readonly caseSensitive?: boolean;
    readonly regex?: boolean;
}

/** A single line match inside a file. */
export interface LineMatch {
    /** 1-based line number. */
    readonly line: number;
    /** The matching line's content, untrimmed (leading whitespace preserved). */
    readonly content: string;
    /** Zero-based character offset where the match starts within `content`. */
    readonly columnStart: number;
    /** Zero-based character offset where the match ends (exclusive). */
    readonly columnEnd: number;
}

/** All matches collected from a single file. */
export interface FileSearchHit {
    readonly relPath: string;
    readonly matches: readonly LineMatch[];
}

export interface SearchWorkspaceResult {
    readonly results: readonly FileSearchHit[];
    readonly totalMatches: number;
    /** True when scanning was aborted early because `maxResults` was reached. */
    readonly truncated: boolean;
    readonly durationMs: number;
    readonly filesScanned: number;
    readonly filesSkipped: number;
}

export interface SearchWorkspaceOptions extends SearchQueryOptions {
    /** Hard cap on total matches across all files. Default 500. */
    readonly maxResults?: number;
    /** Per-file byte cap. Files larger than this are skipped. Default 5 MB. */
    readonly maxFileBytes?: number;
}

const DEFAULT_MAX_RESULTS = 500;
const DEFAULT_MAX_FILE_BYTES = 5_000_000;
const MAX_QUERY_LENGTH_LITERAL = 1_000;
const MAX_QUERY_LENGTH_REGEX = 200;
/**
 * Maximum line length a regex-mode query will evaluate against. Lines
 * longer than this are skipped so a catastrophic-backtracking pattern
 * cannot hang the main process on minified bundles or log dumps.
 */
const MAX_LINE_LENGTH_REGEX = 10_000;

/**
 * Heuristic catastrophic-backtracking signatures. Not exhaustive — a
 * user determined to DoS their own local app can still do so — but
 * catches the common textbook patterns (`(a+)+`, `(a*)*`, `(.|a)+`, etc.)
 * before they ever reach `new RegExp`.
 */
const CATASTROPHIC_PATTERNS: readonly RegExp[] = [
    /\([^)]*[+*]\)[+*]/,    // nested quantifiers: (x+)+ / (x*)*
    /\([^)]*\|[^)]*\)[+*]/, // alternation under quantifier: (a|b)+ (safe-ish — still flagged)
];

/**
 * Build a RegExp from a user query. Literal mode escapes regex
 * metacharacters so bare strings like `a.b` match `a.b` and not `axb`.
 * Throws on invalid regex, over-long queries, and patterns that match a
 * catastrophic-backtracking heuristic in regex mode.
 */
export function compileQuery(query: string, opts: SearchQueryOptions = {}): RegExp {
    if (query.length === 0) {
        throw new Error('Query must not be empty');
    }
    const isRegex = opts.regex === true;
    const maxLen = isRegex ? MAX_QUERY_LENGTH_REGEX : MAX_QUERY_LENGTH_LITERAL;
    if (query.length > maxLen) {
        throw new Error(`Query too long (max ${maxLen} characters)`);
    }
    if (isRegex) {
        for (const sig of CATASTROPHIC_PATTERNS) {
            if (sig.test(query)) {
                throw new Error('Regex rejected: potentially catastrophic backtracking pattern');
            }
        }
    }
    const flags = opts.caseSensitive === true ? 'g' : 'gi';
    const source = isRegex ? query : escapeRegex(query);
    return new RegExp(source, flags);
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scan a single text payload line-by-line and collect match positions.
 * Pure — no IO. Exported so tests can cover the matching logic without
 * a filesystem fixture.
 *
 * Lines longer than `MAX_LINE_LENGTH_REGEX` are skipped to bound the
 * worst-case regex runtime (defence against catastrophic backtracking
 * surviving the `compileQuery` heuristic).
 */
export function matchLinesInContent(content: string, pattern: RegExp): readonly LineMatch[] {
    const out: LineMatch[] = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.length > MAX_LINE_LENGTH_REGEX) continue;
        // Reset lastIndex so the global regex restarts per line — we only
        // capture the *first* match position per line; the whole line is
        // kept for display so subsequent matches are still visible.
        pattern.lastIndex = 0;
        const m = pattern.exec(line);
        if (m !== null) {
            out.push({
                line: i + 1,
                content: line,
                columnStart: m.index,
                columnEnd: m.index + m[0].length,
            });
        }
    }
    return out;
}

/**
 * Walk a workspace rooted at `root`, scanning every file for lines that
 * match `query`. Mirrors the tree walker's exclude rules, skips binaries,
 * caps per-file reads at `maxFileBytes`, and stops when `maxResults` is
 * reached so a ripgrep-heavy query cannot balloon the IPC payload.
 *
 * `root` must already be a validated absolute path (see
 * `resolveSafeWorkspacePath`). This function does not re-validate.
 */
export async function searchWorkspace(
    root: string,
    query: string,
    opts: SearchWorkspaceOptions = {},
): Promise<SearchWorkspaceResult> {
    const start = Date.now();
    const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
    const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const pattern = compileQuery(query, opts);

    const results: FileSearchHit[] = [];
    let totalMatches = 0;
    let truncated = false;
    let filesScanned = 0;
    let filesSkipped = 0;

    const walk = async (absDir: string, relDir: string): Promise<void> => {
        if (truncated) return;
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(absDir, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
            if (truncated) return;
            // Skip symlinks entirely — a link inside the workspace could
            // point anywhere on the filesystem and is not part of the
            // produced artifact surface.
            if (e.isSymbolicLink()) {
                filesSkipped++;
                continue;
            }
            if (e.isDirectory()) {
                if (EXCLUDE_DIRS.has(e.name)) continue;
                await walk(path.join(absDir, e.name), path.posix.join(relDir, e.name));
                continue;
            }
            if (!e.isFile()) continue;
            if (EXCLUDE_FILES.has(e.name)) continue;

            const absFile = path.join(absDir, e.name);
            const relFile = path.posix.join(relDir, e.name);

            let size: number;
            try {
                const stat = await fsp.stat(absFile);
                size = stat.size;
            } catch {
                filesSkipped++;
                continue;
            }
            if (size === 0) {
                filesScanned++;
                continue;
            }
            if (size > maxFileBytes) {
                filesSkipped++;
                continue;
            }
            let binary: boolean;
            try {
                binary = await sniffBinary(absFile, size);
            } catch {
                filesSkipped++;
                continue;
            }
            if (binary) {
                filesSkipped++;
                continue;
            }

            let text: string;
            try {
                text = await fsp.readFile(absFile, { encoding: 'utf8' });
            } catch {
                filesSkipped++;
                continue;
            }
            filesScanned++;

            const matches = matchLinesInContent(text, pattern);
            if (matches.length === 0) continue;

            const remaining = maxResults - totalMatches;
            const clipped = matches.length > remaining ? matches.slice(0, remaining) : matches;
            results.push({ relPath: relFile, matches: clipped });
            totalMatches += clipped.length;
            if (totalMatches >= maxResults) {
                truncated = true;
                return;
            }
        }
    };

    await walk(root, '');

    return {
        results,
        totalMatches,
        truncated,
        durationMs: Date.now() - start,
        filesScanned,
        filesSkipped,
    };
}

/** Re-exported for the IPC handler — keeps consumers off artifact-service. */
export { resolveSafeWorkspacePath };
