/**
 * graph-html-renderer unit tests (v0.1.33)
 *
 * Pinning the contract: the renderer must (a) inline data into the page
 * (no runtime fetch — Chromium blocks file:// fetches), (b) escape every
 * user-controlled string to prevent XSS via node ids / labels, (c) accept
 * both the legacy `links` key and the current `edges` key from
 * graphify's graph.json, (d) survive missing optional fields.
 */

import { describe, it, expect } from 'vitest';
import { renderGraphHtmlFromJson, renderGraphHtmlFromData } from '../../src/main/graph-html-renderer';

describe('renderGraphHtmlFromJson', () => {
    it('returns null on unparseable input rather than producing a broken page', () => {
        expect(renderGraphHtmlFromJson('not json at all', 'project')).toBeNull();
        expect(renderGraphHtmlFromJson('', 'project')).toBeNull();
    });

    it('parses valid JSON and produces an HTML document', () => {
        const json = JSON.stringify({ nodes: [{ id: 'a' }], edges: [] });
        const html = renderGraphHtmlFromJson(json, 'demo');
        expect(html).not.toBeNull();
        expect(html!).toContain('<!doctype html>');
        expect(html!).toContain('vis-network');
    });
});

describe('renderGraphHtmlFromData', () => {
    it('inlines node and edge data into a script block (no runtime fetch)', () => {
        const html = renderGraphHtmlFromData(
            { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] },
            'project',
        );
        // The data must be inlined as JSON inside the page
        expect(html).toContain('"nodes":');
        expect(html).toContain('"edges":');
        // No fetch() of an external file — fragile under file:// origin
        expect(html).not.toMatch(/fetch\(['"]graph\.json['"]\)/);
    });

    it('accepts both `edges` and `links` keys from graph.json', () => {
        const fromEdges = renderGraphHtmlFromData(
            { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] },
            't',
        );
        const fromLinks = renderGraphHtmlFromData(
            { nodes: [{ id: 'a' }, { id: 'b' }], links: [{ source: 'a', target: 'b' }] },
            't',
        );
        // Both should produce a non-empty edges array in the inlined payload
        expect(fromEdges).toContain('"from":"a","to":"b"');
        expect(fromLinks).toContain('"from":"a","to":"b"');
    });

    it('accepts both `source/target` (NetworkX) and `from/to` (vis-network) edge shapes', () => {
        const html = renderGraphHtmlFromData(
            { nodes: [{ id: 'x' }, { id: 'y' }], edges: [{ from: 'x', to: 'y' }] },
            't',
        );
        expect(html).toContain('"from":"x","to":"y"');
    });

    it('drops edges that are missing both ends rather than producing broken DataSet entries', () => {
        const html = renderGraphHtmlFromData(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { nodes: [{ id: 'a' }], edges: [{ source: 'a' } as any, { target: 'a' } as any] },
            't',
        );
        // None of these edges had both endpoints — both must be filtered out
        expect(html).toContain('"edges":[]');
    });

    it('escapes the title in HTML contexts to prevent XSS', () => {
        const html = renderGraphHtmlFromData(
            { nodes: [], edges: [] },
            '<script>alert(1)</script>',
        );
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('shows correct node and edge counts in the HUD', () => {
        const html = renderGraphHtmlFromData(
            { nodes: [{ id: '1' }, { id: '2' }, { id: '3' }],
              edges: [{ source: '1', target: '2' }, { source: '2', target: '3' }] },
            't',
        );
        expect(html).toContain('<strong>3</strong> nodes');
        expect(html).toContain('<strong>2</strong> edges');
    });

    it('derives a readable label from path-shaped ids when no label is provided', () => {
        const html = renderGraphHtmlFromData(
            { nodes: [{ id: 'src/foo/bar.ts::Baz' }], edges: [] },
            't',
        );
        // 'Baz' should appear as the label rather than the full id
        expect(html).toMatch(/"label":"Baz"/);
    });

    it('prefers an explicit label over the derived one', () => {
        const html = renderGraphHtmlFromData(
            { nodes: [{ id: 'a/b/c', label: 'My Symbol' }], edges: [] },
            't',
        );
        expect(html).toMatch(/"label":"My Symbol"/);
    });

    it('handles an empty graph without throwing', () => {
        const html = renderGraphHtmlFromData({}, 'empty');
        expect(html).toContain('<strong>0</strong> nodes');
        expect(html).toContain('<strong>0</strong> edges');
    });

    it('groups nodes by community when available (for colouring)', () => {
        const html = renderGraphHtmlFromData(
            { nodes: [{ id: 'a', community: 3 }, { id: 'b', community: 3 }], edges: [] },
            't',
        );
        expect(html).toContain('"group":"c3"');
    });

    it('passes through file + kind on nodes for click-to-show-source', () => {
        const html = renderGraphHtmlFromData(
            { nodes: [{ id: 'src/foo.ts::Bar', file: 'src/foo.ts', kind: 'function' }], edges: [] },
            't',
        );
        expect(html).toContain('"file":"src/foo.ts"');
        expect(html).toContain('"kind":"function"');
    });

    it('derives a file path from path-shaped ids when no explicit file field exists', () => {
        const html = renderGraphHtmlFromData(
            { nodes: [{ id: 'src/foo/bar.ts::Baz' }], edges: [] },
            't',
        );
        // Should populate file from the part before `::`
        expect(html).toContain('"file":"src/foo/bar.ts"');
    });

    it('leaves file null when the id has no recognisable file segment', () => {
        const html = renderGraphHtmlFromData(
            { nodes: [{ id: 'BareSymbol' }], edges: [] },
            't',
        );
        expect(html).toContain('"file":null');
    });

    it('wires a vis-network selectNode handler that posts to the parent', () => {
        const html = renderGraphHtmlFromData(
            { nodes: [{ id: 'a' }], edges: [] },
            't',
        );
        expect(html).toContain("network.on('selectNode'");
        expect(html).toContain("type: 'kageops:node-click'");
        expect(html).toContain('window.parent.postMessage');
    });
});
