/**
 * Tests for resolveClerkPublishableKeyDetailed — pure key-selection logic
 * extracted from auth-window.ts so it's unit-testable without booting Electron.
 */

import { describe, it, expect } from 'vitest';
import { resolveClerkPublishableKeyDetailed } from '../../src/main/auth-key-resolver';

// Synthetic Clerk publishable keys (base64 decodes to clerk.example.com$ /
// clerk-test.example.com$). Prefix is what the resolver keys off — the domain
// is irrelevant to these tests, so we avoid shipping any real instance key.
const LIVE = 'pk_live_Y2xlcmsuZXhhbXBsZS5jb20k';
const TEST = 'pk_test_Y2xlcmstdGVzdC5leGFtcGxlLmNvbSQ';

describe('resolveClerkPublishableKeyDetailed', () => {
    describe('explicit production mode', () => {
        it.each(['production', 'live', 'prod', 'PRODUCTION', 'Live'])(
            'returns live key when mode=%s and live key set',
            (mode) => {
                const r = resolveClerkPublishableKeyDetailed({ liveKey: LIVE, testKey: TEST, mode });
                expect(r.key).toBe(LIVE);
                expect(r.source).toBe('live-explicit');
                expect(r.warning).toBeUndefined();
            },
        );

        it('returns null + warning when mode=production but no live key', () => {
            const r = resolveClerkPublishableKeyDetailed({ liveKey: undefined, testKey: TEST, mode: 'production' });
            expect(r.key).toBeNull();
            expect(r.source).toBe('none');
            expect(r.warning).toContain('KAGEOPS_AUTH_ENV=production');
        });

        it('returns null + warning when mode=production and live key empty string', () => {
            const r = resolveClerkPublishableKeyDetailed({ liveKey: '', testKey: TEST, mode: 'production' });
            expect(r.key).toBeNull();
            expect(r.source).toBe('none');
        });
    });

    describe('explicit development mode', () => {
        it.each(['development', 'test', 'dev', 'DEVELOPMENT', 'Test'])(
            'returns test key when mode=%s and test key set',
            (mode) => {
                const r = resolveClerkPublishableKeyDetailed({ liveKey: LIVE, testKey: TEST, mode });
                expect(r.key).toBe(TEST);
                expect(r.source).toBe('test-explicit');
            },
        );

        it('returns null + warning when mode=development but no test key', () => {
            const r = resolveClerkPublishableKeyDetailed({ liveKey: LIVE, testKey: undefined, mode: 'dev' });
            expect(r.key).toBeNull();
            expect(r.source).toBe('none');
            expect(r.warning).toContain('KAGEOPS_AUTH_ENV=development');
        });
    });

    describe('auto-select (mode unset or unrecognised)', () => {
        it('prefers live key over test key when both present', () => {
            const r = resolveClerkPublishableKeyDetailed({ liveKey: LIVE, testKey: TEST });
            expect(r.key).toBe(LIVE);
            expect(r.source).toBe('live-auto');
        });

        it('falls back to test key when only test key present', () => {
            const r = resolveClerkPublishableKeyDetailed({ liveKey: undefined, testKey: TEST });
            expect(r.key).toBe(TEST);
            expect(r.source).toBe('test-auto');
        });

        it('returns null when neither key is set', () => {
            const r = resolveClerkPublishableKeyDetailed({});
            expect(r.key).toBeNull();
            expect(r.source).toBe('none');
            expect(r.warning).toBeUndefined(); // not an error — placeholder mode is intentional
        });

        it('treats empty-string keys the same as undefined', () => {
            const r = resolveClerkPublishableKeyDetailed({ liveKey: '', testKey: '' });
            expect(r.key).toBeNull();
            expect(r.source).toBe('none');
        });

        it('ignores unrecognised mode strings (gibberish, typos)', () => {
            const r = resolveClerkPublishableKeyDetailed({
                liveKey: LIVE,
                testKey: TEST,
                mode: 'staging', // not a recognised value
            });
            // Should fall through to auto-select
            expect(r.key).toBe(LIVE);
            expect(r.source).toBe('live-auto');
        });
    });

    describe('safety properties', () => {
        it('never throws for any combination of inputs', () => {
            const inputs: Array<Parameters<typeof resolveClerkPublishableKeyDetailed>[0]> = [
                {},
                { liveKey: '' },
                { testKey: '' },
                { mode: '' },
                { mode: 'PRODUCTION', liveKey: '' },
                { mode: 'gibberish' },
                { mode: 'development', testKey: undefined },
                { liveKey: LIVE, testKey: TEST, mode: undefined },
            ];
            for (const i of inputs) {
                expect(() => resolveClerkPublishableKeyDetailed(i)).not.toThrow();
            }
        });

        it('return shape always matches the ClerkKeyResolution interface', () => {
            const r = resolveClerkPublishableKeyDetailed({ liveKey: LIVE });
            expect(r).toMatchObject({
                key: expect.any(String),
                source: expect.any(String),
            });
        });
    });
});
