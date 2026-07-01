/**
 * Phase 2b — OS-keychain "key register" for app secrets.
 *
 * secret-store is mocked with an in-memory Map so no real OS keychain is
 * touched and the tests run identically in CI.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
const k = (service: string, account: string): string => `${service}::${account}`;

vi.mock('../../src/main/secret-store', () => ({
    setSecret: vi.fn(async (service: string, account: string, value: string) => {
        store.set(k(service, account), value);
    }),
    getSecret: vi.fn(async (service: string, account: string) =>
        store.get(k(service, account)) ?? null
    ),
    deleteSecret: vi.fn(async (service: string, account: string) => {
        store.delete(k(service, account));
    }),
}));

import {
    saveAppEnv,
    loadAppEnv,
    clearAppEnv,
    hasAppEnv,
    appEnvAccount,
} from '../../src/main/app-env-keychain';

beforeEach(() => store.clear());

describe('app-env-keychain', () => {
    it('namespaces the keychain account by project id', () => {
        expect(appEnvAccount('p1')).toBe('app-env:p1');
    });

    it('round-trips a saved app-env map', async () => {
        const env = { DATABASE_URL: 'postgres://x', CLERK_SECRET_KEY: 'sk_test_a' };
        await saveAppEnv('p1', env);
        expect(await loadAppEnv('p1')).toEqual(env);
        expect(await hasAppEnv('p1')).toBe(true);
    });

    it('load returns null when nothing is stored', async () => {
        expect(await loadAppEnv('nope')).toBeNull();
        expect(await hasAppEnv('nope')).toBe(false);
    });

    it('clear removes the blob', async () => {
        await saveAppEnv('p1', { A: '1' });
        await clearAppEnv('p1');
        expect(await loadAppEnv('p1')).toBeNull();
    });

    it('isolates projects by id', async () => {
        await saveAppEnv('p1', { A: '1' });
        await saveAppEnv('p2', { B: '2' });
        expect(await loadAppEnv('p1')).toEqual({ A: '1' });
        expect(await loadAppEnv('p2')).toEqual({ B: '2' });
    });

    it('returns null for a corrupt (non-JSON) blob', async () => {
        store.set(k('kageops', appEnvAccount('p1')), 'not-json{');
        expect(await loadAppEnv('p1')).toBeNull();
    });

    it('returns null for a non-string-map blob', async () => {
        store.set(k('kageops', appEnvAccount('p1')), JSON.stringify({ A: 1, B: true }));
        expect(await loadAppEnv('p1')).toBeNull();
    });

    it('rejects an empty project id on save', async () => {
        await expect(saveAppEnv('', { A: '1' })).rejects.toThrow(/non-empty/);
    });

    it('load/has/clear are no-ops for an empty project id', async () => {
        expect(await loadAppEnv('')).toBeNull();
        expect(await hasAppEnv('')).toBe(false);
        await clearAppEnv(''); // must not throw
    });
});
