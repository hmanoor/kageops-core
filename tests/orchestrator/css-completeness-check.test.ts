/**
 * Tests for css-completeness-check used by AcceptanceGate.
 *
 * Covers the v8-benchmark failure mode: Forge writes rich HTML markup
 * with class names like `.sigil-card`, `.phase-item` but ships a
 * `styles.css` that contains only design tokens — page renders
 * unstyled even though spec rules and static-asset checks all pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() => ''),
    };
});

import * as fs from 'fs';

import { runCssCompletenessCheck } from '../../src/orchestrator/css-completeness-check';

const existsSync = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
const readFileSync = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;

const REPO = '/fake/repo';

beforeEach(() => {
    existsSync.mockReset();
    readFileSync.mockReset();
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue('');
});

function htmlWithClasses(classNames: readonly string[]): string {
    const divs = classNames.map((c) => `<div class="${c}"></div>`).join('\n');
    return `<!DOCTYPE html><html><head>` +
        `<link rel="stylesheet" href="styles.css">` +
        `</head><body>${divs}</body></html>`;
}

function cssWithRules(classNames: readonly string[]): string {
    return classNames.map((c) => `.${c} { color: red; }`).join('\n');
}

describe('runCssCompletenessCheck', () => {
    it('returns no violation for a trivial page (under min-classes threshold)', () => {
        const html = htmlWithClasses(['a', 'b', 'c']);
        readFileSync.mockReturnValue('');
        existsSync.mockReturnValue(true);

        const result = runCssCompletenessCheck(REPO, html);
        expect(result).toEqual([]);
    });

    it('returns no violation when all HTML classes have CSS rules', () => {
        const classes = Array.from({ length: 20 }, (_, i) => `c${i}`);
        const html = htmlWithClasses(classes);
        readFileSync.mockReturnValue(cssWithRules(classes));
        existsSync.mockReturnValue(true);

        const result = runCssCompletenessCheck(REPO, html);
        expect(result).toEqual([]);
    });

    it('tolerates a small number of orphans below absolute threshold', () => {
        const classes = Array.from({ length: 30 }, (_, i) => `c${i}`);
        const html = htmlWithClasses(classes);
        readFileSync.mockReturnValue(cssWithRules(classes.slice(0, 25)));
        existsSync.mockReturnValue(true);

        const result = runCssCompletenessCheck(REPO, html);
        expect(result).toEqual([]);
    });

    it('flags a violation when many classes are orphaned', () => {
        const classes = Array.from({ length: 40 }, (_, i) => `widget${i}`);
        const html = htmlWithClasses(classes);
        readFileSync.mockReturnValue(cssWithRules(['widget0', 'widget1']));
        existsSync.mockReturnValue(true);

        const result = runCssCompletenessCheck(REPO, html);
        expect(result).toHaveLength(1);
        expect(result[0].check).toBe('orphan-css-classes');
        expect(result[0].message).toContain('38 of 40');
        expect(result[0].message).toContain('.widget2');
    });

    it('caps the orphan sample size in the violation message', () => {
        const classes = Array.from({ length: 80 }, (_, i) => `o${i}`);
        const html = htmlWithClasses(classes);
        readFileSync.mockReturnValue('');
        existsSync.mockReturnValue(true);

        const result = runCssCompletenessCheck(REPO, html);
        expect(result).toHaveLength(1);
        expect(result[0].message).toContain('(+50 more)');
    });

    it('extracts CSS classes from inline <style> blocks', () => {
        const classes = Array.from({ length: 25 }, (_, i) => `inline${i}`);
        const inlineRules = classes.map((c) => `.${c} { color: blue; }`).join(' ');
        const html =
            `<html><head><style>${inlineRules}</style></head>` +
            classes.map((c) => `<div class="${c}"></div>`).join('') +
            `</html>`;
        existsSync.mockReturnValue(false);

        const result = runCssCompletenessCheck(REPO, html);
        expect(result).toEqual([]);
    });

    it('ignores CSS class selectors found inside string literals', () => {
        const classes = Array.from({ length: 25 }, (_, i) => `real${i}`);
        const html = htmlWithClasses(classes);
        const css =
            `.real0 { content: ".real99"; }\n` +
            classes.slice(1).map((c) => `.${c} { color: red; }`).join('\n');
        readFileSync.mockReturnValue(css);
        existsSync.mockReturnValue(true);

        const result = runCssCompletenessCheck(REPO, html);
        expect(result).toEqual([]);
    });

    it('handles multiple class names in one class attribute', () => {
        const html = `<html><head><link rel="stylesheet" href="styles.css"></head>` +
            `<body><div class="card card-primary card-elevated"></div>` +
            Array.from({ length: 25 }, (_, i) => `<span class="x${i}"></span>`).join('') +
            `</body></html>`;
        readFileSync.mockReturnValue(
            '.card { } .card-primary { } .card-elevated { } ' +
            Array.from({ length: 25 }, (_, i) => `.x${i} { } `).join('')
        );
        existsSync.mockReturnValue(true);

        const result = runCssCompletenessCheck(REPO, html);
        expect(result).toEqual([]);
    });

    it('skips remote stylesheets and uses styles.css fallback', () => {
        const classes = Array.from({ length: 25 }, (_, i) => `r${i}`);
        const html =
            `<html><head>` +
            `<link rel="stylesheet" href="https://cdn.example.com/external.css">` +
            `<link rel="stylesheet" href="styles.css">` +
            `</head><body>` +
            classes.map((c) => `<div class="${c}"></div>`).join('') +
            `</body></html>`;
        readFileSync.mockReturnValue(cssWithRules(classes));
        existsSync.mockReturnValue(true);

        const result = runCssCompletenessCheck(REPO, html);
        expect(result).toEqual([]);
    });
});
