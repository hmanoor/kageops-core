/**
 * artifact-search-panel unit tests (B-429).
 *
 * Pure HTML-string tests — no DOM required. Covers shell rendering,
 * every state of the results renderer, the highlight helper, and
 * `stateForResponse` transition logic.
 */

import { describe, it, expect } from 'vitest';
import {
    renderSearchShell,
    renderSearchResults,
    highlightRange,
    stateForResponse,
    type SearchPanelState,
} from '../../src/renderer/command-center/artifact-search-panel';

// ── renderSearchShell ────────────────────────────────

describe('renderSearchShell', () => {
    it('includes the search input and filter toggles', () => {
        const html = renderSearchShell({ caseSensitive: false, regex: false });
        expect(html).toContain('data-role="search-input"');
        expect(html).toContain('data-role="case-sensitive"');
        expect(html).toContain('data-role="regex"');
        expect(html).toContain('data-role="search-back"');
        expect(html).toContain('data-role="results"');
    });

    it('reflects the initial toggle state with a `checked` attribute', () => {
        expect(renderSearchShell({ caseSensitive: true, regex: false }))
            .toContain('data-role="case-sensitive" checked');
        expect(renderSearchShell({ caseSensitive: false, regex: true }))
            .toContain('data-role="regex" checked');
    });
});

// ── renderSearchResults ──────────────────────────────

describe('renderSearchResults states', () => {
    it('idle shows a prompt', () => {
        expect(renderSearchResults({ kind: 'idle' })).toMatch(/start typing/i);
    });

    it('loading renders the query (html-escaped)', () => {
        const html = renderSearchResults({ kind: 'loading', query: '<script>' });
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('<script>');
    });

    it('error renders the message (html-escaped)', () => {
        const html = renderSearchResults({
            kind: 'error',
            query: 'x',
            message: '<img onerror=alert(1)>',
        });
        expect(html).toContain('&lt;img');
        expect(html).not.toContain('<img onerror');
    });

    it('empty state reports files scanned + duration', () => {
        const html = renderSearchResults({
            kind: 'empty',
            query: 'missing',
            filesScanned: 42,
            durationMs: 17,
        });
        expect(html).toContain('42 file');
        expect(html).toContain('17 ms');
    });

    it('results render the summary, file path, and match rows', () => {
        const state: SearchPanelState = {
            kind: 'results',
            query: 'HIT',
            view: {
                results: [
                    {
                        relPath: 'src/a.ts',
                        matches: [
                            { line: 7, content: 'const HIT = 1;', columnStart: 6, columnEnd: 9 },
                        ],
                    },
                ],
                totalMatches: 1,
                truncated: false,
                durationMs: 3,
                filesScanned: 5,
                filesSkipped: 0,
            },
        };
        const html = renderSearchResults(state);
        expect(html).toContain('src/a.ts');
        expect(html).toContain('1 match');
        expect(html).toContain('5 scanned');
        expect(html).toContain('data-role="search-match"');
        expect(html).toContain('data-path="src/a.ts"');
        expect(html).toContain('data-line="7"');
        expect(html).toContain('<mark class="ab-search-hit">HIT</mark>');
    });

    it('results shows truncated note when view.truncated is true', () => {
        const html = renderSearchResults({
            kind: 'results',
            query: 'x',
            view: {
                results: [
                    { relPath: 'a.ts', matches: [{ line: 1, content: 'x', columnStart: 0, columnEnd: 1 }] },
                ],
                totalMatches: 1,
                truncated: true,
                durationMs: 1,
                filesScanned: 1,
                filesSkipped: 0,
            },
        });
        expect(html).toMatch(/truncated/i);
    });
});

// ── highlightRange ───────────────────────────────────

describe('highlightRange', () => {
    it('wraps the hit range in <mark> and escapes neighbours', () => {
        expect(highlightRange('a<b>c', 1, 4)).toBe(
            'a<mark class="ab-search-hit">&lt;b&gt;</mark>c',
        );
    });

    it('returns fully escaped content when start == end', () => {
        expect(highlightRange('<x>', 2, 2)).toBe('&lt;x&gt;');
    });

    it('clamps out-of-range indices without crashing', () => {
        expect(highlightRange('abc', -5, 100)).toContain('<mark class="ab-search-hit">abc</mark>');
    });
});

// ── stateForResponse ─────────────────────────────────

describe('stateForResponse', () => {
    it('returns error state on failure', () => {
        const s = stateForResponse('q', {
            success: false,
            error: 'boom',
            results: [],
            totalMatches: 0,
            truncated: false,
            durationMs: 0,
            filesScanned: 0,
        });
        expect(s.kind).toBe('error');
    });

    it('returns empty state when no matches', () => {
        const s = stateForResponse('q', {
            success: true,
            results: [],
            totalMatches: 0,
            truncated: false,
            durationMs: 4,
            filesScanned: 20,
        });
        expect(s.kind).toBe('empty');
    });

    it('returns results state when matches are present', () => {
        const s = stateForResponse('q', {
            success: true,
            results: [
                { relPath: 'a.ts', matches: [{ line: 1, content: 'q', columnStart: 0, columnEnd: 1 }] },
            ],
            totalMatches: 1,
            truncated: false,
            durationMs: 2,
            filesScanned: 3,
        });
        expect(s.kind).toBe('results');
    });
});
