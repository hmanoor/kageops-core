/**
 * P1-11 — Forge bundle dispatch tests.
 *
 * Exercises the gating decision tree: env flag → DB lookup →
 * registry resolution. The actual scaffold execution is unchanged
 * inline code that this PR doesn't touch.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/db/client', () => ({
    query: vi.fn(),
}));

import { query } from '../../../src/db/client';
import { BundleRegistry } from '../../../src/bundles/bundle-registry';
import {
    parseBundleKey,
    resolveBundleForProject,
} from '../../../src/agents/specialists/forge-bundle-dispatch';
import type { LoadedBundle } from '../../../src/bundles/types';

const mockQuery = vi.mocked(query);

function makeBundle(name: string): LoadedBundle {
    return {
        directory: `/fake/bundles/stacks/${name}`,
        manifest: {
            schemaVersion: 1,
            name,
            kind: 'stack',
            version: '1.0.0',
            description: 'test',
        },
    };
}

beforeEach(() => {
    mockQuery.mockReset();
    delete process.env['KAGEOPS_FEATURE_BUNDLES'];
});

// ── parseBundleKey ──

describe('parseBundleKey()', () => {
    it('parses well-formed keys', () => {
        expect(parseBundleKey('stack::vanilla-html')).toEqual({ kind: 'stack', name: 'vanilla-html' });
        expect(parseBundleKey('capability::auth-clerk')).toEqual({
            kind: 'capability',
            name: 'auth-clerk',
        });
        expect(parseBundleKey('deployer::vercel')).toEqual({ kind: 'deployer', name: 'vercel' });
    });

    it('rejects missing separator', () => {
        expect(parseBundleKey('vanilla-html')).toBeNull();
    });

    it('rejects unknown kind', () => {
        expect(parseBundleKey('nonsense::foo')).toBeNull();
    });

    it('rejects non-kebab-case name', () => {
        expect(parseBundleKey('stack::Vanilla_HTML')).toBeNull();
    });

    it('rejects empty string', () => {
        expect(parseBundleKey('')).toBeNull();
    });
});

// ── resolveBundleForProject ──

describe('resolveBundleForProject()', () => {
    // Pillar 2.2 PR-E: flag defaults to ON. Tests below run with the flag
    // unset (= on) and assert the new behaviour; the explicit-off case is
    // covered by the dedicated "flag-off when explicitly false" test.

    it('runs through (no flag-off) when env flag is unset (default ON)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ selected_bundle: null }], rowCount: 1 } as never);
        const registry = new BundleRegistry({ bundles: [], errors: [] });
        const result = await resolveBundleForProject({ projectId: 'p1', registry });
        expect(result.status).toBe('no-selection');
        expect(mockQuery).toHaveBeenCalled();
    });

    it('returns flag-off when env flag is explicitly "false"', async () => {
        process.env['KAGEOPS_FEATURE_BUNDLES'] = 'false';
        const registry = new BundleRegistry({ bundles: [], errors: [] });
        const result = await resolveBundleForProject({ projectId: 'p1', registry });
        expect(result.status).toBe('flag-off');
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('runs through (no flag-off) when env flag is set to any non-"false" value', async () => {
        process.env['KAGEOPS_FEATURE_BUNDLES'] = '1';
        mockQuery.mockResolvedValueOnce({ rows: [{ selected_bundle: null }], rowCount: 1 } as never);
        const registry = new BundleRegistry({ bundles: [], errors: [] });
        const result = await resolveBundleForProject({ projectId: 'p1', registry });
        expect(result.status).toBe('no-selection');
    });

    it('returns no-selection when projects.selected_bundle is NULL', async () => {
        process.env['KAGEOPS_FEATURE_BUNDLES'] = 'true';
        mockQuery.mockResolvedValueOnce({ rows: [{ selected_bundle: null }], rowCount: 1 } as never);
        const registry = new BundleRegistry({ bundles: [], errors: [] });
        const result = await resolveBundleForProject({ projectId: 'p1', registry });
        expect(result.status).toBe('no-selection');
    });

    it('returns no-selection when project row is missing entirely', async () => {
        process.env['KAGEOPS_FEATURE_BUNDLES'] = 'true';
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
        const registry = new BundleRegistry({ bundles: [], errors: [] });
        const result = await resolveBundleForProject({ projectId: 'p1', registry });
        expect(result.status).toBe('no-selection');
    });

    it('returns no-selection when DB throws (defensive — never crashes Forge)', async () => {
        process.env['KAGEOPS_FEATURE_BUNDLES'] = 'true';
        mockQuery.mockRejectedValueOnce(new Error('pg-disconnected'));
        const registry = new BundleRegistry({ bundles: [], errors: [] });
        const result = await resolveBundleForProject({ projectId: 'p1', registry });
        expect(result.status).toBe('no-selection');
    });

    it('returns malformed-key when selected_bundle value is junk', async () => {
        process.env['KAGEOPS_FEATURE_BUNDLES'] = 'true';
        mockQuery.mockResolvedValueOnce({
            rows: [{ selected_bundle: 'not-a-valid-key' }],
            rowCount: 1,
        } as never);
        const registry = new BundleRegistry({ bundles: [], errors: [] });
        const result = await resolveBundleForProject({ projectId: 'p1', registry });
        expect(result.status).toBe('malformed-key');
        if (result.status === 'malformed-key') {
            expect(result.key).toBe('not-a-valid-key');
        }
    });

    it('returns unknown-bundle when key is well-formed but no bundle registered', async () => {
        process.env['KAGEOPS_FEATURE_BUNDLES'] = 'true';
        mockQuery.mockResolvedValueOnce({
            rows: [{ selected_bundle: 'stack::nonexistent' }],
            rowCount: 1,
        } as never);
        const registry = new BundleRegistry({ bundles: [], errors: [] });
        const result = await resolveBundleForProject({ projectId: 'p1', registry });
        expect(result.status).toBe('unknown-bundle');
        if (result.status === 'unknown-bundle') {
            expect(result.key).toBe('stack::nonexistent');
        }
    });

    it('returns hit with the loaded bundle on full success', async () => {
        process.env['KAGEOPS_FEATURE_BUNDLES'] = 'true';
        mockQuery.mockResolvedValueOnce({
            rows: [{ selected_bundle: 'stack::vanilla-html' }],
            rowCount: 1,
        } as never);
        const registry = new BundleRegistry({
            bundles: [makeBundle('vanilla-html')],
            errors: [],
        });
        const result = await resolveBundleForProject({ projectId: 'p1', registry });
        expect(result.status).toBe('hit');
        if (result.status === 'hit') {
            expect(result.hit.bundle.manifest.name).toBe('vanilla-html');
            expect(result.hit.key).toBe('stack::vanilla-html');
        }
    });
});
