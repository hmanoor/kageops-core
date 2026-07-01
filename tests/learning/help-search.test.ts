/**
 * Tests for src/learning/help-search.ts — query sanitiser + formatter.
 *
 * The DB query path is exercised in integration tests; here we focus
 * on the pure helpers (sanitiseQuery, formatHelpContext).
 */

import { describe, expect, it } from 'vitest';
import { __test__, formatHelpContext, type HelpHit } from '../../src/learning/help-search';

const { sanitiseQuery } = __test__;

describe('help-search · sanitiseQuery', () => {
    it('returns null for empty input', () => {
        expect(sanitiseQuery('')).toBeNull();
    });
    it('returns null for whitespace-only input', () => {
        expect(sanitiseQuery('   ')).toBeNull();
    });
    it('returns null for single-character tokens (filtered as too short)', () => {
        expect(sanitiseQuery('a b')).toBeNull();
    });
    it('lowercases and applies prefix matching', () => {
        expect(sanitiseQuery('Preset')).toBe('preset:*');
    });
    it('joins multiple terms with AND', () => {
        expect(sanitiseQuery('design provider')).toBe('design:* & provider:*');
    });
    it('strips punctuation and special characters', () => {
        expect(sanitiseQuery('how do I use OpenAI?')).toBe('how:* & do:* & use:* & openai:*');
    });
    it('drops short tokens but keeps long ones', () => {
        expect(sanitiseQuery('a quick fox')).toBe('quick:* & fox:*');
    });
});

describe('help-search · formatHelpContext', () => {
    it('returns null when there are no hits', () => {
        expect(formatHelpContext([])).toBeNull();
    });

    it('builds a labelled block per hit', () => {
        const hits: readonly HelpHit[] = [
            {
                docSlug: 'presets',
                docTitle: 'Presets',
                heading: 'Silent fallback',
                content: 'Watch out for unknown preset names.',
                score: 0.5,
            },
        ];
        const formatted = formatHelpContext(hits);
        expect(formatted).not.toBeNull();
        expect(formatted!).toContain('RELEVANT HELP DOCS');
        expect(formatted!).toContain('docs/help/presets.md');
        expect(formatted!).toContain('Silent fallback');
        expect(formatted!).toContain('Watch out for unknown preset names.');
    });

    it('omits empty heading prefix', () => {
        const hits: readonly HelpHit[] = [
            {
                docSlug: 'quickstart',
                docTitle: 'Quickstart',
                heading: '',
                content: 'Boot the app.',
                score: 0.3,
            },
        ];
        const formatted = formatHelpContext(hits)!;
        expect(formatted).toContain('[Help #1: Quickstart');
        // No " — " separator before the title when heading is empty.
        expect(formatted).not.toContain(' — Quickstart');
    });

    it('numbers hits sequentially', () => {
        const hits: readonly HelpHit[] = [
            { docSlug: 'a', docTitle: 'A', heading: '', content: 'one', score: 1 },
            { docSlug: 'b', docTitle: 'B', heading: '', content: 'two', score: 0.5 },
            { docSlug: 'c', docTitle: 'C', heading: '', content: 'three', score: 0.1 },
        ];
        const formatted = formatHelpContext(hits)!;
        expect(formatted).toContain('[Help #1: A');
        expect(formatted).toContain('[Help #2: B');
        expect(formatted).toContain('[Help #3: C');
    });
});
