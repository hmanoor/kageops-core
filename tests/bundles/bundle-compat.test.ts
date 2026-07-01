/**
 * P1-13 — Bundle compatibility check tests.
 *
 * Pure unit tests — no fixtures, no I/O. Loader-integration coverage
 * (via `loadBundleFromDirectory`) lives in bundle-loader.test.ts and
 * is added in this PR.
 */

import { describe, it, expect } from 'vitest';

import { checkBundleCompat } from '../../src/bundles/bundle-compat';

describe('checkBundleCompat() — permissive default', () => {
    it('returns ok when constraint is undefined', () => {
        const result = checkBundleCompat(undefined, '0.2.0-beta.6');
        expect(result.ok).toBe(true);
    });
});

describe('checkBundleCompat() — happy paths', () => {
    it('accepts a host that satisfies an exact-version range', () => {
        const result = checkBundleCompat('1.0.0', '1.0.0');
        expect(result.ok).toBe(true);
    });

    it('accepts a host within a >= constraint', () => {
        const result = checkBundleCompat('>=0.2.0', '0.2.5');
        expect(result.ok).toBe(true);
    });

    it('accepts a host within a >=A <B compound range', () => {
        const result = checkBundleCompat('>=0.2.0 <0.3.0', '0.2.9');
        expect(result.ok).toBe(true);
    });

    it('accepts a prerelease host when range covers its release line', () => {
        // The whole point of includePrerelease: true.
        const result = checkBundleCompat('>=0.2.0 <0.3.0', '0.2.0-beta.6');
        expect(result.ok).toBe(true);
    });

    it('accepts a caret-range satisfied by a patch bump', () => {
        const result = checkBundleCompat('^1.0.0', '1.4.7');
        expect(result.ok).toBe(true);
    });
});

describe('checkBundleCompat() — incompatible hosts', () => {
    it('rejects a host below the range', () => {
        const result = checkBundleCompat('>=0.3.0', '0.2.5');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toMatch(/bundle requires host kageops_version >=0\.3\.0, but host is 0\.2\.5/);
        }
    });

    it('rejects a host above the upper bound', () => {
        const result = checkBundleCompat('>=0.2.0 <0.3.0', '0.4.0');
        expect(result.ok).toBe(false);
    });

    it('rejects a prerelease that falls in a different major', () => {
        const result = checkBundleCompat('>=0.2.0 <0.3.0', '0.4.0-beta.1');
        expect(result.ok).toBe(false);
    });
});

describe('checkBundleCompat() — malformed inputs', () => {
    it('rejects with a clear error when constraint is not a valid range', () => {
        const result = checkBundleCompat('not-a-range', '0.2.0');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toMatch(/not a valid semver range/);
        }
    });

    it('rejects with a clear error when host version is not semver-coercible', () => {
        const result = checkBundleCompat('>=0.2.0', 'tuesday');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toMatch(/host version "tuesday" is not a valid semver/);
        }
    });
});
