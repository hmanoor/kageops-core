/**
 * Unit tests for `extractUrls()` — the helper Scout/Herald use to detect
 * URLs inside free-form task descriptions before calling webResearch.
 */

import { describe, it, expect } from 'vitest';
import { extractUrls } from '../../src/agents/url-extraction';

describe('extractUrls', () => {
    it('returns empty array for empty string', () => {
        expect(extractUrls('')).toEqual([]);
    });

    it('returns empty array when text contains no URLs', () => {
        expect(extractUrls('Research our top three competitors.')).toEqual([]);
    });

    it('extracts a single https URL', () => {
        const result = extractUrls('See https://example.com for details.');
        expect(result).toEqual(['https://example.com']);
    });

    it('extracts a single http URL', () => {
        const result = extractUrls('Legacy site at http://example.org');
        expect(result).toEqual(['http://example.org']);
    });

    it('extracts multiple distinct URLs in order', () => {
        const result = extractUrls(
            'Compare https://a.com and https://b.com and also https://c.com',
        );
        expect(result).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
    });

    it('strips trailing period', () => {
        const result = extractUrls('Visit https://example.com.');
        expect(result).toEqual(['https://example.com']);
    });

    it('strips trailing comma', () => {
        const result = extractUrls('Check https://example.com, then reply.');
        expect(result).toEqual(['https://example.com']);
    });

    it('strips trailing close-paren (markdown link style)', () => {
        const result = extractUrls('See the [docs](https://example.com/docs).');
        expect(result).toEqual(['https://example.com/docs']);
    });

    it('strips trailing semicolon / quote / bracket', () => {
        expect(extractUrls('go https://a.com;')).toEqual(['https://a.com']);
        expect(extractUrls("go 'https://a.com'")).toEqual(['https://a.com']);
        expect(extractUrls('go [https://a.com]')).toEqual(['https://a.com']);
    });

    it('deduplicates repeated URLs preserving first-seen order', () => {
        const result = extractUrls(
            'Links: https://example.com, https://other.com, https://example.com.',
        );
        expect(result).toEqual(['https://example.com', 'https://other.com']);
    });

    it('extracts URLs with paths, query strings, and fragments', () => {
        const result = extractUrls(
            'Go to https://example.com/path/to/page?foo=bar&baz=qux#section',
        );
        expect(result).toEqual([
            'https://example.com/path/to/page?foo=bar&baz=qux#section',
        ]);
    });

    it('extracts URLs embedded in markdown link syntax', () => {
        const result = extractUrls(
            'See the [official docs](https://docs.example.com/guide) and [blog](https://blog.example.com).',
        );
        expect(result).toEqual([
            'https://docs.example.com/guide',
            'https://blog.example.com',
        ]);
    });

    it('handles mixed http/https content with punctuation', () => {
        const result = extractUrls(
            'Modern: https://new.example.com. Legacy: http://old.example.com; archive: (https://archive.example.com).',
        );
        expect(result).toEqual([
            'https://new.example.com',
            'http://old.example.com',
            'https://archive.example.com',
        ]);
    });

    it('ignores protocol-less URLs like www.example.com', () => {
        // Per spec, iter 1 only matches http(s) URLs.
        const result = extractUrls('Visit www.example.com for details.');
        expect(result).toEqual([]);
    });

    it('ignores bare domains without scheme', () => {
        const result = extractUrls('Reach out at hello@example.com or example.com');
        expect(result).toEqual([]);
    });

    it('returns readonly array (cannot mutate)', () => {
        const result = extractUrls('https://example.com');
        // Type-level readonly; at runtime, confirm shape still usable.
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(1);
    });
});
