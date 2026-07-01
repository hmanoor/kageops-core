/**
 * File Deduplication Checker
 *
 * Before Forge writes a file, this module checks if a similar module
 * already exists in the repo. Prevents duplicate implementations
 * (e.g., 4 different discovery modules).
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Types ───────────────────────────────────────────

export interface DedupResult {
    readonly hasDuplicate: boolean;
    readonly existingPath: string | null;
    readonly similarity: number; // 0-1
    readonly recommendation: 'skip' | 'merge' | 'write';
}

// ── Constants ───────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache']);

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

const EXPORT_REGEX = /export\s+(?:class|function|interface|type|const|enum)\s+(\w+)/g;

/** Match PascalCase and camelCase identifiers of 4+ chars */
const IDENTIFIER_REGEX = /\b([A-Z][a-zA-Z0-9]{3,}|[a-z][a-zA-Z0-9]{3,})\b/g;

// ── Helpers ─────────────────────────────────────────

/**
 * Walk a directory recursively, returning all code file paths (relative to root).
 */
function walkCodeFiles(rootDir: string): readonly string[] {
    const results: string[] = [];

    function walk(dir: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) {
                    walk(path.join(dir, entry.name));
                }
            } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) {
                results.push(path.relative(rootDir, path.join(dir, entry.name)));
            }
        }
    }

    walk(rootDir);
    return results;
}

/**
 * Normalized Levenshtein distance between two strings (0 = identical, 1 = completely different).
 * Returns similarity as 1 - normalizedDistance.
 */
function filenameSimilarity(a: string, b: string): number {
    const s1 = path.basename(a, path.extname(a)).toLowerCase();
    const s2 = path.basename(b, path.extname(b)).toLowerCase();

    if (s1 === s2) return 1;
    if (s1.length === 0 || s2.length === 0) return 0;

    const maxLen = Math.max(s1.length, s2.length);

    // Simple Levenshtein via matrix
    const matrix: number[][] = [];
    for (let i = 0; i <= s1.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= s2.length; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= s1.length; i++) {
        for (let j = 1; j <= s2.length; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }

    return 1 - matrix[s1.length][s2.length] / maxLen;
}

/**
 * Extract exported symbol names from source code.
 */
function extractExports(content: string): ReadonlySet<string> {
    const exports = new Set<string>();
    let match: RegExpExecArray | null;
    const regex = new RegExp(EXPORT_REGEX.source, EXPORT_REGEX.flags);
    while ((match = regex.exec(content)) !== null) {
        exports.add(match[1]);
    }
    return exports;
}

/**
 * Compute overlap ratio between two sets. Returns 0-1.
 */
function setOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const item of a) {
        if (b.has(item)) intersection++;
    }
    const minSize = Math.min(a.size, b.size);
    return minSize === 0 ? 0 : intersection / minSize;
}

/**
 * Extract significant identifiers from content.
 */
function extractKeywords(content: string): ReadonlySet<string> {
    const keywords = new Set<string>();
    let match: RegExpExecArray | null;
    const regex = new RegExp(IDENTIFIER_REGEX.source, IDENTIFIER_REGEX.flags);
    while ((match = regex.exec(content)) !== null) {
        keywords.add(match[1]);
    }
    return keywords;
}

// ── Main Class ──────────────────────────────────────

export class FileDedupChecker {
    /**
     * Check if a file about to be written is a duplicate of an existing file.
     * Uses filename similarity + content keyword overlap.
     */
    checkForDuplicate(
        repoPath: string,
        newFilePath: string,
        newContent: string
    ): DedupResult {
        const existingFiles = walkCodeFiles(repoPath);
        const newExports = extractExports(newContent);
        const newKeywords = extractKeywords(newContent);

        let bestScore = 0;
        let bestPath: string | null = null;

        for (const existingFile of existingFiles) {
            // Skip comparing against itself
            const normalizedNew = newFilePath.replace(/\\/g, '/');
            const normalizedExisting = existingFile.replace(/\\/g, '/');
            if (normalizedNew === normalizedExisting) continue;

            const fnameSim = filenameSimilarity(newFilePath, existingFile);

            // Only read existing file if filename has some similarity (optimization)
            if (fnameSim < 0.15 && newExports.size === 0) continue;

            let existingContent: string;
            try {
                existingContent = fs.readFileSync(path.join(repoPath, existingFile), 'utf-8');
            } catch {
                continue;
            }

            const existingExports = extractExports(existingContent);
            const existingKeywords = extractKeywords(existingContent);

            const exportOverlap = setOverlap(newExports, existingExports);
            const keywordOverlap = setOverlap(newKeywords, existingKeywords);

            const combined = 0.3 * fnameSim + 0.3 * exportOverlap + 0.4 * keywordOverlap;

            if (combined > bestScore) {
                bestScore = combined;
                bestPath = existingFile;
            }
        }

        const recommendation: DedupResult['recommendation'] =
            bestScore >= 0.82 ? 'skip' :
            bestScore >= 0.65 ? 'merge' :
            'write';

        return {
            hasDuplicate: bestScore >= 0.65,
            existingPath: bestScore >= 0.65 ? bestPath : null,
            similarity: Math.round(bestScore * 1000) / 1000,
            recommendation,
        };
    }
}

// ── Exported Helpers (for testing) ──────────────────

export { filenameSimilarity, extractExports, extractKeywords, setOverlap, walkCodeFiles };
