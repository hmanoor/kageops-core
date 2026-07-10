/**
 * Forge file-content context (harness-coherence fix).
 *
 * The Tier-3 benchmark's schema-never-wired failure was pinpointed to this: when
 * Forge implements a bundle feature it was given only the LIST of existing file
 * names, not their CONTENTS. Editing `lib/db/schema.ts` blind, it emitted a
 * standalone migration ("without file read access I can't see current SQL")
 * that added the `bookmarks` table to the SQL but never to the Drizzle schema
 * the ORM actually reads — so the app could never query it.
 *
 * `buildExistingFileContext` formats the CURRENT content of the key files Forge
 * is about to edit, with an explicit instruction to EDIT them (return full
 * updated content) rather than recreate/replace them.
 */
import { describe, it, expect } from 'vitest';
import {
    buildExistingFileContext,
    KEY_BUNDLE_FILES,
} from '../../src/agents/forge-file-context';

describe('buildExistingFileContext', () => {
    it('returns empty string when there are no files', () => {
        expect(buildExistingFileContext([])).toBe('');
    });

    it('skips files with blank content', () => {
        expect(buildExistingFileContext([{ path: 'lib/db/schema.ts', content: '   \n' }])).toBe('');
    });

    it('emits the current content of each file with an EDIT-not-recreate instruction', () => {
        const out = buildExistingFileContext([
            { path: 'lib/db/schema.ts', content: "export const users = pgTable('users', {});" },
        ]);
        expect(out).toContain('EXISTING FILE: lib/db/schema.ts');
        expect(out).toContain("export const users = pgTable('users', {});");
        // must steer Forge to edit, not emit a blank/replacement/standalone migration
        expect(out.toLowerCase()).toMatch(/edit/);
        expect(out.toLowerCase()).toMatch(/do not|don't/);
    });

    it('truncates very long files at the per-file budget', () => {
        const big = 'x'.repeat(10_000);
        const out = buildExistingFileContext([{ path: 'a.ts', content: big }], { maxCharsPerFile: 1000 });
        expect(out.length).toBeLessThan(2000);
        expect(out).toMatch(/truncat/i);
    });

    it('includes the Drizzle schema in the default key-file list', () => {
        expect(KEY_BUNDLE_FILES).toContain('lib/db/schema.ts');
    });
});
