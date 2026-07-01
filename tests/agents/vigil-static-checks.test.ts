/**
 * Unit tests for Vigil's deterministic static checks.
 *
 * These checks reject broken code-review artifacts (HTML/JS selector
 * mismatches, dual scaffolds) before any LLM call, providing 100% recall
 * for the specific defects covered here.
 */

import { describe, it, expect } from 'vitest';
import {
    extractHtmlIds,
    extractJsSelectors,
    checkHtmlJsIdMatches,
    checkDualScaffold,
    runStaticChecks,
    formatViolationsReport,
} from '../../src/agents/specialists/vigil-static-checks';

// ── extractHtmlIds ───────────────────────────────────

describe('extractHtmlIds', () => {
    it('extracts double-quoted IDs', () => {
        expect(extractHtmlIds('<div id="foo"></div>')).toEqual(['foo']);
    });

    it('extracts single-quoted IDs', () => {
        expect(extractHtmlIds("<div id='bar'></div>")).toEqual(['bar']);
    });

    it('handles multiple IDs and extra whitespace', () => {
        const html = `
            <button id = "incrementBtn">+</button>
            <div id="valueDisplay">0</div>
            <button id ='decrementBtn'>-</button>
        `;
        expect(extractHtmlIds(html)).toEqual(['incrementBtn', 'valueDisplay', 'decrementBtn']);
    });

    it('returns empty array when no IDs present', () => {
        expect(extractHtmlIds('<div class="foo"></div>')).toEqual([]);
    });

    it('ignores aria-labelledby and similar attrs', () => {
        const html = '<div aria-labelledby="foo" id="bar"></div>';
        expect(extractHtmlIds(html)).toEqual(['bar']);
    });
});

// ── extractJsSelectors ───────────────────────────────

describe('extractJsSelectors', () => {
    it('captures getElementById calls', () => {
        const js = `const el = document.getElementById('counter-value');`;
        expect(extractJsSelectors(js)).toEqual([
            { value: 'counter-value', source: 'getElementById' },
        ]);
    });

    it('captures querySelector with # prefix', () => {
        const js = `document.querySelector("#foo")`;
        expect(extractJsSelectors(js)).toEqual([
            { value: 'foo', source: 'querySelector' },
        ]);
    });

    it('captures querySelectorAll with # prefix', () => {
        const js = `document.querySelectorAll('#bar')`;
        expect(extractJsSelectors(js)).toEqual([
            { value: 'bar', source: 'querySelectorAll' },
        ]);
    });

    it('ignores class selectors', () => {
        const js = `document.querySelector('.btn')`;
        expect(extractJsSelectors(js)).toEqual([]);
    });

    it('ignores dynamic (variable / template) selectors', () => {
        const js = [
            'document.getElementById(someVar);',
            'document.getElementById(`item-${id}`);',
        ].join('\n');
        expect(extractJsSelectors(js)).toEqual([]);
    });

    it('captures multiple selectors from a real file', () => {
        const js = `
            const counterDisplay = document.getElementById('counter-value');
            const incrementBtn = document.getElementById('increment-btn');
            const decrementBtn = document.getElementById('decrement-btn');
        `;
        expect(extractJsSelectors(js)).toEqual([
            { value: 'counter-value', source: 'getElementById' },
            { value: 'increment-btn', source: 'getElementById' },
            { value: 'decrement-btn', source: 'getElementById' },
        ]);
    });
});

// ── checkHtmlJsIdMatches ─────────────────────────────

describe('checkHtmlJsIdMatches', () => {
    it('passes when all JS selectors match HTML IDs', () => {
        const files = new Map([
            ['index.html', '<button id="go">go</button>'],
            ['script.js', "document.getElementById('go');"],
        ]);
        expect(checkHtmlJsIdMatches(files)).toEqual([]);
    });

    it('flags the CounterV7 mismatch case', () => {
        const files = new Map([
            [
                'index.html',
                `<button id="incrementBtn">+</button>
                 <button id="decrementBtn">-</button>
                 <div id="valueDisplay">0</div>`,
            ],
            [
                'script.js',
                `
                document.getElementById('counter-value');
                document.getElementById('increment-btn');
                document.getElementById('decrement-btn');
                `,
            ],
        ]);
        const violations = checkHtmlJsIdMatches(files);
        expect(violations).toHaveLength(3);
        for (const v of violations) {
            expect(v.check).toBe('id-mismatch');
            expect(v.severity).toBe('critical');
            expect(v.file).toBe('script.js');
            expect(v.message).toContain('does not exist');
        }
        const badIds = violations.map((v) => v.message);
        expect(badIds.some((m) => m.includes('counter-value'))).toBe(true);
        expect(badIds.some((m) => m.includes('increment-btn'))).toBe(true);
        expect(badIds.some((m) => m.includes('decrement-btn'))).toBe(true);
    });

    it('skips check entirely when no HTML files present', () => {
        const files = new Map([
            ['server.ts', "document.getElementById('nonexistent');"],
        ]);
        expect(checkHtmlJsIdMatches(files)).toEqual([]);
    });

    it('de-duplicates repeated selectors in the same file', () => {
        const files = new Map([
            ['index.html', '<div id="ok"></div>'],
            [
                'script.js',
                "document.getElementById('missing');document.getElementById('missing');",
            ],
        ]);
        const violations = checkHtmlJsIdMatches(files);
        expect(violations).toHaveLength(1);
    });

    it('unions IDs across multiple HTML files', () => {
        const files = new Map([
            ['page1.html', '<div id="a"></div>'],
            ['page2.html', '<div id="b"></div>'],
            ['script.js', "document.getElementById('a');document.getElementById('b');"],
        ]);
        expect(checkHtmlJsIdMatches(files)).toEqual([]);
    });
});

// ── checkDualScaffold ────────────────────────────────

describe('checkDualScaffold', () => {
    it('flags root index.html + React in package.json', () => {
        const files = new Map([
            ['index.html', '<!DOCTYPE html>'],
            [
                'package.json',
                JSON.stringify({
                    dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
                }),
            ],
        ]);
        const violations = checkDualScaffold(files);
        expect(violations).toHaveLength(1);
        expect(violations[0].check).toBe('dual-scaffold');
        expect(violations[0].severity).toBe('high');
        expect(violations[0].message).toContain('react');
    });

    it('flags rollup/vite dev dependencies', () => {
        const files = new Map([
            ['index.html', '<!DOCTYPE html>'],
            [
                'package.json',
                JSON.stringify({ devDependencies: { rollup: '^4.0.0' } }),
            ],
        ]);
        expect(checkDualScaffold(files)).toHaveLength(1);
    });

    it('passes when only static HTML is present', () => {
        const files = new Map([['index.html', '<!DOCTYPE html>']]);
        expect(checkDualScaffold(files)).toEqual([]);
    });

    it('passes when package.json has no framework', () => {
        const files = new Map([
            ['index.html', '<!DOCTYPE html>'],
            ['package.json', JSON.stringify({ dependencies: { lodash: '^4.0.0' } })],
        ]);
        expect(checkDualScaffold(files)).toEqual([]);
    });

    it('handles invalid JSON gracefully', () => {
        const files = new Map([
            ['index.html', '<!DOCTYPE html>'],
            ['package.json', '{not valid json'],
        ]);
        expect(checkDualScaffold(files)).toEqual([]);
    });

    it('passes when no root index.html', () => {
        const files = new Map([
            ['src/index.html', '<!DOCTYPE html>'],
            ['package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } })],
        ]);
        expect(checkDualScaffold(files)).toEqual([]);
    });
});

// ── checkInlineCssBloat (F-371) ──────────────────────

describe('checkInlineCssBloat (F-371)', () => {
    it('passes when inline <style> is small (under cap)', () => {
        const files = new Map([['index.html', '<style>\n.a { color: red; }\n</style>']]);
        const result = runStaticChecks(files);
        expect(result.violations.filter((v) => v.check === 'inline-css-bloat')).toEqual([]);
    });

    it('flags a 50-line inline <style> block as bloat', () => {
        const bigBlock = '<style>\n' + Array(50).fill('.foo { color: red; }').join('\n') + '\n</style>';
        const files = new Map([['index.html', bigBlock]]);
        const result = runStaticChecks(files);
        const bloat = result.violations.filter((v) => v.check === 'inline-css-bloat');
        expect(bloat).toHaveLength(1);
        expect(bloat[0].file).toBe('index.html');
        expect(bloat[0].severity).toBe('high');
    });

    it('sums across multiple <style> blocks in one file', () => {
        const html =
            '<style>\n' + Array(25).fill('.a {}').join('\n') + '\n</style>' +
            '<div>x</div>' +
            '<style>\n' + Array(25).fill('.b {}').join('\n') + '\n</style>';
        const result = runStaticChecks(new Map([['index.html', html]]));
        const bloat = result.violations.filter((v) => v.check === 'inline-css-bloat');
        expect(bloat).toHaveLength(1);
    });

    it('does not flag non-HTML files (no <style> parsing of .ts etc.)', () => {
        const fauxStyle = 'const s = `<style>\n' + Array(100).fill('x').join('\n') + '\n</style>`;';
        const result = runStaticChecks(new Map([['script.ts', fauxStyle]]));
        expect(result.violations.filter((v) => v.check === 'inline-css-bloat')).toEqual([]);
    });
});

// ── runStaticChecks ──────────────────────────────────

describe('runStaticChecks', () => {
    it('passes on a clean static counter app', () => {
        const files = new Map([
            [
                'index.html',
                `<button id="incrementBtn">+</button>
                 <button id="decrementBtn">-</button>
                 <div id="valueDisplay">0</div>`,
            ],
            [
                'script.js',
                `
                document.getElementById('incrementBtn');
                document.getElementById('decrementBtn');
                document.getElementById('valueDisplay');
                `,
            ],
        ]);
        const result = runStaticChecks(files);
        expect(result.passed).toBe(true);
        expect(result.violations).toEqual([]);
    });

    it('rejects the full CounterV7 defect set', () => {
        const files = new Map([
            [
                'index.html',
                `<button id="incrementBtn">+</button>
                 <button id="decrementBtn">-</button>
                 <div id="valueDisplay">0</div>`,
            ],
            [
                'script.js',
                `document.getElementById('counter-value');
                 document.getElementById('increment-btn');
                 document.getElementById('decrement-btn');`,
            ],
            [
                'package.json',
                JSON.stringify({
                    dependencies: { react: '^18.0.0' },
                    devDependencies: { rollup: '^4.0.0' },
                }),
            ],
        ]);
        const result = runStaticChecks(files);
        expect(result.passed).toBe(false);
        // 3 id-mismatch + 1 dual-scaffold
        expect(result.violations).toHaveLength(4);
        const kinds = result.violations.map((v) => v.check);
        expect(kinds.filter((k) => k === 'id-mismatch')).toHaveLength(3);
        expect(kinds.filter((k) => k === 'dual-scaffold')).toHaveLength(1);
    });

    it('summary string contains all violations for Forge feedback loop', () => {
        const files = new Map([
            ['index.html', '<div id="ok"></div>'],
            ['script.js', "document.getElementById('missing');"],
        ]);
        const result = runStaticChecks(files);
        expect(result.summary).toContain('id-mismatch');
        expect(result.summary).toContain('FIX:');
        expect(result.summary).toContain('missing');
    });
});

// ── formatViolationsReport ───────────────────────────

describe('formatViolationsReport', () => {
    it('produces a markdown report with fix instructions', () => {
        const files = new Map([
            ['index.html', '<div id="ok"></div>'],
            ['script.js', "document.getElementById('missing');"],
        ]);
        const result = runStaticChecks(files);
        const report = formatViolationsReport(result.violations);
        expect(report).toContain('# Code Review — Rejected by Deterministic Checks');
        expect(report).toContain('Required fix:');
        expect(report).toContain('[CRITICAL]');
    });
});
