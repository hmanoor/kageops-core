/**
 * Tests for static-asset sanity checks used by AcceptanceGate.
 *
 * Covers the exact class of failures the 2026-04-22 GreenThumb run
 * slipped past: markdown-fenced CSS, unclosed CSS braces, and a
 * `<script src>` that targets a file that doesn't exist on disk.
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

import {
    collectLinkedAssets,
    hasMarkdownFence,
    hasBalancedBraces,
    isRemote,
    runStaticAssetChecks,
} from '../../src/orchestrator/static-asset-checks';

const existsSync = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
const readFileSync = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
    existsSync.mockReset();
    readFileSync.mockReset();
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue('');
});

describe('isRemote', () => {
    it('treats http:// and https:// URLs as remote', () => {
        expect(isRemote('http://example.com/a.css')).toBe(true);
        expect(isRemote('https://example.com/a.css')).toBe(true);
    });

    it('treats protocol-relative //cdn as remote', () => {
        expect(isRemote('//cdn.example.com/a.css')).toBe(true);
    });

    it('treats data: URLs as remote', () => {
        expect(isRemote('data:text/css;base64,eA==')).toBe(true);
    });

    it('treats plain relative paths as local', () => {
        expect(isRemote('styles.css')).toBe(false);
        expect(isRemote('./assets/a.js')).toBe(false);
        expect(isRemote('/absolute/path.css')).toBe(false);
    });
});

describe('collectLinkedAssets', () => {
    it('extracts stylesheet links', () => {
        const html = '<link rel="stylesheet" href="style.css">';
        expect(collectLinkedAssets(html)).toEqual([
            { href: 'style.css', kind: 'css' },
        ]);
    });

    it('extracts <link> without rel as stylesheet (lenient)', () => {
        const html = '<link href="style.css">';
        const assets = collectLinkedAssets(html);
        expect(assets).toContainEqual({ href: 'style.css', kind: 'css' });
    });

    it('skips <link rel="icon"> and other non-stylesheet links', () => {
        const html = '<link rel="icon" href="favicon.ico"><link rel="stylesheet" href="a.css">';
        expect(collectLinkedAssets(html)).toEqual([
            { href: 'a.css', kind: 'css' },
        ]);
    });

    it('extracts <script src> entries', () => {
        const html = '<script src="script.js"></script><script src="app.js"></script>';
        expect(collectLinkedAssets(html)).toEqual([
            { href: 'script.js', kind: 'js' },
            { href: 'app.js', kind: 'js' },
        ]);
    });

    it('ignores inline <script> tags with no src', () => {
        const html = '<script>console.log("hi")</script>';
        expect(collectLinkedAssets(html)).toEqual([]);
    });

    it('handles single-quoted and unquoted attributes', () => {
        const html = `<link rel=stylesheet href='a.css'><script src=b.js></script>`;
        const assets = collectLinkedAssets(html);
        expect(assets).toContainEqual({ href: 'a.css', kind: 'css' });
        expect(assets).toContainEqual({ href: 'b.js', kind: 'js' });
    });
});

describe('hasMarkdownFence', () => {
    it('flags a leading ```css fence', () => {
        expect(hasMarkdownFence('```css\nbody { color: red; }\n')).toBe(true);
    });

    it('flags a bare ``` fence anywhere', () => {
        expect(hasMarkdownFence('body { color: red; }\n```')).toBe(true);
    });

    it('accepts clean CSS', () => {
        expect(hasMarkdownFence('body { color: red; }\n')).toBe(false);
    });

    it('ignores backticks inside content (not at line start)', () => {
        expect(hasMarkdownFence('body::before { content: "```"; }')).toBe(false);
    });
});

describe('hasBalancedBraces', () => {
    it('passes balanced CSS', () => {
        expect(hasBalancedBraces('body { color: red; } h1 { margin: 0; }')).toBe(true);
    });

    it('fails when closing brace is missing (GreenThumb truncation)', () => {
        expect(hasBalancedBraces('body { color: red; } .empty-state {')).toBe(false);
    });

    it('fails when too many closing braces', () => {
        expect(hasBalancedBraces('body { color: red; } }')).toBe(false);
    });

    it('ignores braces inside strings', () => {
        expect(hasBalancedBraces('body::before { content: "{{{"; }')).toBe(true);
    });

    it('ignores braces inside block comments', () => {
        expect(hasBalancedBraces('/* { { */ body { color: red; } /* } */')).toBe(true);
    });
});

describe('runStaticAssetChecks', () => {
    const tempRepo = '/fake/repo';

    it('flags a missing local script file', () => {
        existsSync.mockImplementation((p: unknown) => !String(p).endsWith('script.js'));

        const html = '<script src="script.js"></script>';
        const violations = runStaticAssetChecks(tempRepo, html);
        expect(violations).toHaveLength(1);
        expect(violations[0].check).toBe('missing-asset');
        expect(violations[0].expected).toBe('script.js');
    });

    it('skips remote CDN scripts', () => {
        existsSync.mockReturnValue(false);

        const html = '<script src="https://cdn.example.com/app.js"></script>';
        expect(runStaticAssetChecks(tempRepo, html)).toEqual([]);
        expect(existsSync).not.toHaveBeenCalled();
    });

    it('flags markdown-fenced CSS (the GreenThumb case)', () => {
        existsSync.mockReturnValue(true);
        readFileSync.mockReturnValue('```css\nbody { color: red; }\n');

        const html = '<link rel="stylesheet" href="style.css">';
        const violations = runStaticAssetChecks(tempRepo, html);
        expect(violations.some((v) => v.check === 'markdown-fenced-asset')).toBe(true);
    });

    it('flags unbalanced CSS braces (mid-rule truncation)', () => {
        existsSync.mockReturnValue(true);
        readFileSync.mockReturnValue('body { color: red; } .empty-state {');

        const html = '<link rel="stylesheet" href="style.css">';
        const violations = runStaticAssetChecks(tempRepo, html);
        expect(violations.some((v) => v.check === 'unbalanced-css-braces')).toBe(true);
    });

    it('does not flag balance on JS files (we only brace-check CSS)', () => {
        existsSync.mockReturnValue(true);
        readFileSync.mockReturnValue('if (true) { doThing(); ');

        const html = '<script src="app.js"></script>';
        const violations = runStaticAssetChecks(tempRepo, html);
        expect(violations.some((v) => v.check === 'unbalanced-css-braces')).toBe(false);
    });

    it('strips ?query and #hash before resolving', () => {
        existsSync.mockReturnValue(true);
        readFileSync.mockReturnValue('');

        const html = '<link rel="stylesheet" href="style.css?v=3">';
        runStaticAssetChecks(tempRepo, html);
        const calls = existsSync.mock.calls.map((c: unknown[]) => String(c[0]));
        expect(calls.some((c: string) => c.endsWith('style.css'))).toBe(true);
        expect(calls.some((c: string) => c.includes('?v=3'))).toBe(false);
    });

    it('passes a clean artifact', () => {
        existsSync.mockReturnValue(true);
        readFileSync.mockImplementation((p: unknown) => {
            if (String(p).endsWith('.css')) return 'body { color: red; }';
            if (String(p).endsWith('.js')) return 'console.log("ok");';
            return '';
        });

        const html = '<link rel="stylesheet" href="style.css"><script src="script.js"></script>';
        expect(runStaticAssetChecks(tempRepo, html)).toEqual([]);
    });
});
