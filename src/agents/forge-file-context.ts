/**
 * Forge file-content context (harness-coherence fix).
 *
 * When Forge implements a bundle feature it was previously given only the LIST
 * of existing file names (see `getExistingFilesContext`), not their CONTENTS.
 * Editing `lib/db/schema.ts` blind, it emitted a standalone migration
 * ("without file read access I can't see current SQL") that added the domain
 * table to the SQL but never to the Drizzle schema the ORM reads — the exact
 * Tier-3 benchmark failure.
 *
 * This module formats the CURRENT content of the key files Forge is about to
 * edit, with an explicit instruction to EDIT them (return their full updated
 * content) rather than recreate/replace them or emit a diverging migration.
 * Pure + unit-tested; the agent reads the file contents (repo-scoped) and hands
 * them here.
 */

export interface FileForContext {
    readonly path: string;
    readonly content: string;
}

export interface ExistingFileContextOptions {
    /** Per-file character budget before truncation. */
    readonly maxCharsPerFile?: number;
}

/**
 * Files a bundle feature most often needs to EXTEND rather than recreate. The
 * Drizzle schema is the recurring offender — a feature adds a table by editing
 * this file, not by emitting a fresh migration. The task's own outputPath is
 * added by the caller.
 */
export const KEY_BUNDLE_FILES: readonly string[] = ['lib/db/schema.ts'];

const DEFAULT_MAX_CHARS_PER_FILE = 4000;

/**
 * Build a prompt block showing the current content of existing files Forge is
 * about to edit. Empty/blank files and an empty list produce ''.
 */
export function buildExistingFileContext(
    files: readonly FileForContext[],
    opts: ExistingFileContextOptions = {},
): string {
    const maxChars = opts.maxCharsPerFile ?? DEFAULT_MAX_CHARS_PER_FILE;

    const blocks = files
        .filter((f) => f.content.trim().length > 0)
        .map((f) => {
            const clipped =
                f.content.length > maxChars
                    ? f.content.slice(0, maxChars) + '\n/* … truncated … */'
                    : f.content;
            return (
                `--- EXISTING FILE: ${f.path} (EDIT this file — do NOT recreate it) ---\n` +
                `${clipped}\n` +
                `--- END ${f.path} ---`
            );
        });

    if (blocks.length === 0) return '';

    return (
        `These files ALREADY EXIST with the content shown below. When your task ` +
        `modifies one of them — e.g. adding a table to the Drizzle schema — EDIT ` +
        `the existing file and return its FULL updated content. Do NOT emit a blank ` +
        `or replacement file, and do NOT emit a standalone migration that diverges ` +
        `from the schema. Keep every existing export intact and add to it.\n\n` +
        blocks.join('\n\n')
    );
}
