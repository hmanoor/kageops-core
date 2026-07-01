/**
 * F-395 — auto-updater channel resolution.
 *
 * The runtime stub (initAutoUpdater) is packaged-only and depends on
 * electron-updater + the live `app.isPackaged` check, so we don't
 * exercise the full init here. Instead we lock in:
 *
 *   1. `resolveChannel()` — pure, the only function the rest of the
 *      module trusts. All precedence + normalisation logic.
 *   2. The shape contract — input layers in, exactly `'latest' | 'beta'` out.
 *
 * History: before F-395, the runtime hard-coded
 *   `(process.env['KAGEOPS_RELEASE_CHANNEL'] ?? 'latest').toLowerCase()`
 * which stranded every beta installation looking at the latest feed.
 * These tests are the regression net against re-collapsing that surface.
 */

import { describe, it, expect } from 'vitest';
import { resolveChannel } from '../../src/main/auto-updater';

describe('resolveChannel() — F-395 precedence', () => {
    describe('happy paths', () => {
        it('returns "latest" when every layer is empty (hard default)', () => {
            expect(resolveChannel({ env: undefined, settings: null, embedded: null }))
                .toBe('latest');
        });

        it('uses env var when only env is set', () => {
            expect(resolveChannel({ env: 'beta', settings: null, embedded: null }))
                .toBe('beta');
        });

        it('uses settings when only settings is set', () => {
            expect(resolveChannel({ env: undefined, settings: 'beta', embedded: null }))
                .toBe('beta');
        });

        it('uses embedded when only embedded is set', () => {
            expect(resolveChannel({ env: undefined, settings: null, embedded: 'beta' }))
                .toBe('beta');
        });
    });

    describe('precedence (env > settings > embedded > default)', () => {
        it('env wins over all lower layers', () => {
            expect(resolveChannel({ env: 'latest', settings: 'beta', embedded: 'beta' }))
                .toBe('latest');
        });

        it('settings wins over embedded', () => {
            expect(resolveChannel({ env: undefined, settings: 'latest', embedded: 'beta' }))
                .toBe('latest');
        });

        it('embedded wins over default when env + settings empty', () => {
            expect(resolveChannel({ env: undefined, settings: null, embedded: 'beta' }))
                .toBe('beta');
        });

        it('exact F-395-bug scenario: beta installer, no env, no settings → embedded "beta" wins', () => {
            // This is the exact case that was broken pre-F-395.
            // electron-builder bakes channel:beta into app-update.yml for
            // beta builds; operator never sets the env or settings; we
            // must end up on the beta feed, not the latest feed.
            expect(resolveChannel({ env: undefined, settings: null, embedded: 'beta' }))
                .toBe('beta');
        });

        it('exact reverse: stable installer (embedded latest) → latest', () => {
            expect(resolveChannel({ env: undefined, settings: null, embedded: 'latest' }))
                .toBe('latest');
        });
    });

    describe('normalisation', () => {
        it('lowercases mixed-case env values', () => {
            expect(resolveChannel({ env: 'BETA', settings: null, embedded: null }))
                .toBe('beta');
            expect(resolveChannel({ env: 'Latest', settings: null, embedded: null }))
                .toBe('latest');
        });

        it('trims whitespace at every layer', () => {
            expect(resolveChannel({ env: '  beta  ', settings: null, embedded: null }))
                .toBe('beta');
            expect(resolveChannel({ env: undefined, settings: null, embedded: '\tbeta\n' }))
                .toBe('beta');
        });

        it('treats empty string at env layer as "not set" (falls through)', () => {
            // Regression guard: `export KAGEOPS_RELEASE_CHANNEL=""` shouldn't
            // override a real beta setting/embedded. Otherwise a stale shell
            // export would silently strand the user.
            expect(resolveChannel({ env: '', settings: 'beta', embedded: null }))
                .toBe('beta');
        });

        it('treats whitespace-only env as "not set"', () => {
            expect(resolveChannel({ env: '   ', settings: 'beta', embedded: null }))
                .toBe('beta');
        });

        it('treats whitespace-only embedded as "not set"', () => {
            expect(resolveChannel({ env: undefined, settings: null, embedded: '   ' }))
                .toBe('latest');
        });
    });

    describe('clamping unknown values', () => {
        it('rejects unknown env value (falls through to next layer)', () => {
            // Defensive against a typo in a CI env definition or a future
            // channel name that doesn't exist on R2 yet.
            expect(resolveChannel({ env: 'nightly', settings: 'beta', embedded: null }))
                .toBe('beta');
        });

        it('rejects unknown embedded value (falls through to default)', () => {
            // If an installer somehow shipped with `channel: prerelease`,
            // we'd rather point at the working /latest/ feed than 404.
            expect(resolveChannel({ env: undefined, settings: null, embedded: 'prerelease' }))
                .toBe('latest');
        });

        it('rejects unknown values at all layers → default latest', () => {
            expect(resolveChannel({ env: 'foo', settings: null, embedded: 'bar' }))
                .toBe('latest');
        });
    });

    describe('settings semantics (null is "no override")', () => {
        it('null settings + null embedded → default', () => {
            expect(resolveChannel({ env: undefined, settings: null, embedded: null }))
                .toBe('latest');
        });

        it('null settings + valid embedded → embedded wins', () => {
            expect(resolveChannel({ env: undefined, settings: null, embedded: 'beta' }))
                .toBe('beta');
        });

        it('null settings + null embedded + valid env → env wins', () => {
            expect(resolveChannel({ env: 'beta', settings: null, embedded: null }))
                .toBe('beta');
        });

        it('explicit "latest" setting beats "beta" embedded — operator-chosen opt-OUT of beta', () => {
            // The scenario where an operator on a beta install wants to
            // pin themselves to stable: settings override does that.
            expect(resolveChannel({ env: undefined, settings: 'latest', embedded: 'beta' }))
                .toBe('latest');
        });

        it('explicit "beta" setting beats "latest" embedded — operator-chosen opt-IN to beta', () => {
            // The symmetric case — operator on stable wants to try beta.
            expect(resolveChannel({ env: undefined, settings: 'beta', embedded: 'latest' }))
                .toBe('beta');
        });
    });

    describe('return type narrowing', () => {
        it('always returns exactly "latest" | "beta" (literal narrowing for callers)', () => {
            const result = resolveChannel({ env: undefined, settings: null, embedded: null });
            // Type-level check: the variable below must satisfy the literal union
            // (TS will fail to compile if `resolveChannel` returns `string`).
            const _narrowed: 'latest' | 'beta' = result;
            expect(_narrowed).toBe('latest');
        });
    });
});
