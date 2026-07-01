/**
 * Tests for src/learning/help-indexer.ts — chunking + helpers.
 *
 * The DB-touching path is exercised in integration tests; here we
 * focus on the pure-function helpers exposed via __test__.
 */

import { describe, expect, it } from 'vitest';
import { __test__ } from '../../src/learning/help-indexer';

const { splitByH2, extractTitle, slugFromFilename, hashContent } = __test__;

describe('help-indexer · pure helpers', () => {
    describe('slugFromFilename', () => {
        it('strips numeric prefix and .md suffix', () => {
            expect(slugFromFilename('01-quickstart.md')).toBe('quickstart');
            expect(slugFromFilename('07-pro-tips.md')).toBe('pro-tips');
        });
        it('handles filenames without numeric prefix', () => {
            expect(slugFromFilename('readme.md')).toBe('readme');
        });
        it('case-insensitive .md suffix', () => {
            expect(slugFromFilename('01-foo.MD')).toBe('foo');
        });
    });

    describe('extractTitle', () => {
        it('reads the first H1 heading', () => {
            expect(extractTitle('# Quickstart\n\nbody here')).toBe('Quickstart');
        });
        it('falls back to first non-empty line when no H1', () => {
            expect(extractTitle('\n\nNot a heading\nstuff')).toBe('Not a heading');
        });
        it('returns null for empty input', () => {
            expect(extractTitle('')).toBeNull();
        });
        it('finds H1 mid-document if no leading H1', () => {
            // First non-empty line would win, so test H1 placed first.
            expect(extractTitle('# Title\n\n## Sub\n\ntext')).toBe('Title');
        });
    });

    describe('splitByH2', () => {
        it('splits a doc into one chunk per H2 section', () => {
            const md = [
                '# Title',
                'lead-in',
                '',
                '## Section A',
                'a body',
                '',
                '## Section B',
                'b body',
            ].join('\n');
            const chunks = splitByH2(md);
            expect(chunks).toHaveLength(3);
            expect(chunks[0].heading).toBe('');
            expect(chunks[0].content).toContain('lead-in');
            expect(chunks[1].heading).toBe('Section A');
            expect(chunks[1].content).toBe('a body');
            expect(chunks[2].heading).toBe('Section B');
            expect(chunks[2].content).toBe('b body');
        });

        it('returns one chunk for docs with no H2 headings', () => {
            const chunks = splitByH2('# Title\n\nonly body, no h2');
            expect(chunks).toHaveLength(1);
            expect(chunks[0].heading).toBe('');
            expect(chunks[0].content).toContain('only body');
        });

        it('drops empty chunks (heading + content both blank)', () => {
            // A document that's only whitespace yields no chunks.
            expect(splitByH2('\n\n\n')).toHaveLength(0);
        });

        it('assigns sequential indices', () => {
            const md = '## A\nx\n## B\ny\n## C\nz';
            const chunks = splitByH2(md);
            expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
        });

        it('keeps headings even when content is empty', () => {
            const chunks = splitByH2('## Empty section\n\n## Next\nbody');
            expect(chunks).toHaveLength(2);
            expect(chunks[0].heading).toBe('Empty section');
            expect(chunks[0].content).toBe('');
        });
    });

    describe('hashContent', () => {
        it('returns a 16-char hex digest', () => {
            const h = hashContent('hello world');
            expect(h).toMatch(/^[0-9a-f]{16}$/);
        });
        it('is deterministic', () => {
            expect(hashContent('same')).toBe(hashContent('same'));
        });
        it('changes when input changes', () => {
            expect(hashContent('a')).not.toBe(hashContent('b'));
        });
    });
});
