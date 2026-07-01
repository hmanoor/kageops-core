/**
 * P2-04 — vercel deployer bundle integration test.
 *
 * Confirms bundles/deployers/vercel/bundle.yaml loads cleanly via the
 * existing bundle-loader and is queryable as a deployer via the registry.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { loadBundles } from '../../src/bundles/bundle-loader';
import { BundleRegistry } from '../../src/bundles/bundle-registry';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLES_ROOT = path.join(REPO_ROOT, 'bundles');
const TEST_HOST_VERSION = '0.3.0';

describe('vercel deployer bundle (P2-04)', () => {
    it('loads from disk with no errors', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        expect(result.errors).toEqual([]);
        const vercel = result.bundles.find((b) => b.manifest.name === 'vercel');
        expect(vercel).toBeDefined();
        expect(vercel!.manifest.kind).toBe('deployer');
    });

    it('is queryable via BundleRegistry.get("deployer", "vercel")', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        const registry = new BundleRegistry(result);
        const hit = registry.get('deployer', 'vercel');
        expect(hit?.manifest.name).toBe('vercel');
    });

    it('declares match phrases for Vercel + Next.js terminology', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        const vercel = result.bundles.find((b) => b.manifest.name === 'vercel');
        const phrases = vercel?.manifest.match?.phrases ?? [];
        expect(phrases).toContain('deploy to vercel');
        expect(phrases).toContain('vercel preview');
    });

    it('has skip_npm: true (Vercel host runs the build, not KageOps)', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        const vercel = result.bundles.find((b) => b.manifest.name === 'vercel');
        expect(vercel?.manifest.build?.skip_npm).toBe(true);
    });
});
