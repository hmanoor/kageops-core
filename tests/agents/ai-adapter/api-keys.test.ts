/**
 * Direct unit tests for the provider-API-key resolver.
 *
 * Priority: explicit key argument → provider_keys registry (DB) →
 * secret-store (Keychain/env). The registry lookup must short-circuit
 * for the remainder of the process once it throws (e.g. DB not ready).
 *
 * We exercise each branch by re-importing the module with different mocks
 * using `vi.resetModules()` / dynamic `import()`, since the module-scoped
 * `registryAvailable` flag is sticky.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('resolveProviderApiKey — priority chain', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('returns the explicit key argument immediately without touching registry or store', async () => {
        const registrySpy = vi.fn(async () => 'from-registry');
        const storeSpy = vi.fn(async () => 'from-store');

        vi.doMock('../../../src/main/provider-key-registry', () => ({
            resolveDefaultKey: registrySpy,
        }));
        vi.doMock('../../../src/main/secret-store', () => ({
            getApiKey: storeSpy,
        }));

        const { resolveProviderApiKey } = await import('../../../src/agents/ai-adapter/api-keys');
        const result = await resolveProviderApiKey('claude', 'explicit-key');

        expect(result).toBe('explicit-key');
        expect(registrySpy).not.toHaveBeenCalled();
        expect(storeSpy).not.toHaveBeenCalled();
    });

    it('ignores an empty explicit key and falls through to the registry', async () => {
        const registrySpy = vi.fn(async () => 'from-registry');
        const storeSpy = vi.fn(async () => 'from-store');

        vi.doMock('../../../src/main/provider-key-registry', () => ({
            resolveDefaultKey: registrySpy,
        }));
        vi.doMock('../../../src/main/secret-store', () => ({
            getApiKey: storeSpy,
        }));

        const { resolveProviderApiKey } = await import('../../../src/agents/ai-adapter/api-keys');
        const result = await resolveProviderApiKey('openai', '');

        expect(result).toBe('from-registry');
        expect(registrySpy).toHaveBeenCalledWith('openai');
        expect(storeSpy).not.toHaveBeenCalled();
    });

    it('falls through to the secret store when the registry returns null', async () => {
        const registrySpy = vi.fn(async () => null);
        const storeSpy = vi.fn(async () => 'from-store');

        vi.doMock('../../../src/main/provider-key-registry', () => ({
            resolveDefaultKey: registrySpy,
        }));
        vi.doMock('../../../src/main/secret-store', () => ({
            getApiKey: storeSpy,
        }));

        const { resolveProviderApiKey } = await import('../../../src/agents/ai-adapter/api-keys');
        const result = await resolveProviderApiKey('gemini');

        expect(result).toBe('from-store');
        expect(registrySpy).toHaveBeenCalledTimes(1);
        expect(storeSpy).toHaveBeenCalledWith('gemini');
    });

    it('returns null when neither registry nor store has a key', async () => {
        vi.doMock('../../../src/main/provider-key-registry', () => ({
            resolveDefaultKey: vi.fn(async () => null),
        }));
        vi.doMock('../../../src/main/secret-store', () => ({
            getApiKey: vi.fn(async () => null),
        }));

        const { resolveProviderApiKey } = await import('../../../src/agents/ai-adapter/api-keys');
        const result = await resolveProviderApiKey('openrouter');

        expect(result).toBeNull();
    });

    it('treats an empty-string registry key as "no key found" and falls through', async () => {
        const storeSpy = vi.fn(async () => 'store-key');

        vi.doMock('../../../src/main/provider-key-registry', () => ({
            resolveDefaultKey: vi.fn(async () => ''),
        }));
        vi.doMock('../../../src/main/secret-store', () => ({
            getApiKey: storeSpy,
        }));

        const { resolveProviderApiKey } = await import('../../../src/agents/ai-adapter/api-keys');
        const result = await resolveProviderApiKey('claude');

        expect(result).toBe('store-key');
        expect(storeSpy).toHaveBeenCalled();
    });

    it('disables the registry for the rest of the session when it throws', async () => {
        const registrySpy = vi.fn(async () => {
            throw new Error('DB not ready');
        });
        const storeSpy = vi.fn(async () => 'store-key');

        vi.doMock('../../../src/main/provider-key-registry', () => ({
            resolveDefaultKey: registrySpy,
        }));
        vi.doMock('../../../src/main/secret-store', () => ({
            getApiKey: storeSpy,
        }));

        const { resolveProviderApiKey } = await import('../../../src/agents/ai-adapter/api-keys');

        // First call: registry throws, falls through to store.
        const first = await resolveProviderApiKey('claude');
        expect(first).toBe('store-key');
        expect(registrySpy).toHaveBeenCalledTimes(1);

        // Second call: registry should NOT be invoked again — the one-shot
        // failure flipped the internal `registryAvailable` flag.
        const second = await resolveProviderApiKey('openai');
        expect(second).toBe('store-key');
        expect(registrySpy).toHaveBeenCalledTimes(1);
        expect(storeSpy).toHaveBeenCalledTimes(2);
    });

    it('swallows a secret-store failure and returns null (never throws)', async () => {
        vi.doMock('../../../src/main/provider-key-registry', () => ({
            resolveDefaultKey: vi.fn(async () => null),
        }));
        vi.doMock('../../../src/main/secret-store', () => ({
            getApiKey: vi.fn(async () => {
                throw new Error('Keychain locked');
            }),
        }));

        const { resolveProviderApiKey } = await import('../../../src/agents/ai-adapter/api-keys');
        const result = await resolveProviderApiKey('claude');

        expect(result).toBeNull();
    });
});
