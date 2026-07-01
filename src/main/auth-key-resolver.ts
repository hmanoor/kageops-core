/**
 * Clerk publishable-key selection logic — extracted from auth-window.ts so
 * it can be unit-tested without booting Electron's session/BrowserWindow.
 *
 * Selection order:
 *   1. `KAGEOPS_AUTH_ENV` explicit override (`production` | `development`)
 *   2. Auto: prefer LIVE (`CLERK_PUBLISHABLE_KEY`, `pk_live_…`) when present
 *   3. Fall back to TEST (`CLERK_PUBLISHABLE_TEST_KEY`, `pk_test_…`)
 *   4. `null` if nothing configured (caller falls back to dev placeholder UI)
 */
export interface ClerkKeySources {
    readonly liveKey?: string | undefined;
    readonly testKey?: string | undefined;
    readonly mode?: string | undefined;
}

export interface ClerkKeyResolution {
    readonly key: string | null;
    readonly source: 'live-explicit' | 'test-explicit' | 'live-auto' | 'test-auto' | 'none';
    readonly warning?: string | undefined;
}

export function resolveClerkPublishableKeyDetailed(sources: ClerkKeySources): ClerkKeyResolution {
    const live = sources.liveKey;
    const test = sources.testKey;
    const mode = (sources.mode ?? '').toLowerCase();

    if (mode === 'production' || mode === 'live' || mode === 'prod') {
        if (live === undefined || live.length === 0) {
            return {
                key: null,
                source: 'none',
                warning: 'KAGEOPS_AUTH_ENV=production but CLERK_PUBLISHABLE_KEY is not set',
            };
        }
        return { key: live, source: 'live-explicit' };
    }

    if (mode === 'development' || mode === 'test' || mode === 'dev') {
        if (test === undefined || test.length === 0) {
            return {
                key: null,
                source: 'none',
                warning: 'KAGEOPS_AUTH_ENV=development but CLERK_PUBLISHABLE_TEST_KEY is not set',
            };
        }
        return { key: test, source: 'test-explicit' };
    }

    if (live !== undefined && live.length > 0) {
        return { key: live, source: 'live-auto' };
    }
    if (test !== undefined && test.length > 0) {
        return { key: test, source: 'test-auto' };
    }
    return { key: null, source: 'none' };
}

/**
 * Convenience wrapper that reads from process.env.
 */
export function resolveClerkPublishableKeyFromEnv(): ClerkKeyResolution {
    return resolveClerkPublishableKeyDetailed({
        liveKey: process.env['CLERK_PUBLISHABLE_KEY'],
        testKey: process.env['CLERK_PUBLISHABLE_TEST_KEY'],
        mode: process.env['KAGEOPS_AUTH_ENV'],
    });
}
