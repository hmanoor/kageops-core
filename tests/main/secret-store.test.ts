/**
 * Secret store behavioral tests
 *
 * Tests keytar-backed secret storage with env var fallback.
 * The module uses dynamic import('keytar') with a lazy loader that
 * caches results. vi.resetModules() resets the cache between tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock keytar ─────────────────────────────────────────────────────────────

const mockKeytar = vi.hoisted(() => ({
    getPassword: vi.fn(async () => null as string | null),
    setPassword: vi.fn(async () => undefined),
    deletePassword: vi.fn(async () => true),
    findPassword: vi.fn(async () => null as string | null),
}));

vi.mock('keytar', () => mockKeytar);

// ── Tests ───────────────────────────────────────────────────────────────────

describe('secret-store', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset modules to clear the keytarLoadAttempted cache
        vi.resetModules();
    });

    describe('getSecret()', () => {
        it('returns stored value when keytar works', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce('my-secret');

            const { getSecret } = await import('../../src/main/secret-store');
            const result = await getSecret('kageops', 'test-account');

            expect(result).toBe('my-secret');
            expect(mockKeytar.getPassword).toHaveBeenCalledWith('kageops', 'test-account');
        });

        it('returns null for missing key', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce(null);

            const { getSecret } = await import('../../src/main/secret-store');
            const result = await getSecret('kageops', 'nonexistent');

            expect(result).toBeNull();
        });

        it('returns null when keytar getPassword throws', async () => {
            mockKeytar.getPassword.mockRejectedValueOnce(new Error('access denied'));

            const { getSecret } = await import('../../src/main/secret-store');
            const result = await getSecret('kageops', 'test-account');

            expect(result).toBeNull();
        });
    });

    describe('setSecret()', () => {
        it('calls keytar.setPassword with correct args', async () => {
            const { setSecret } = await import('../../src/main/secret-store');
            await setSecret('kageops', 'test-account', 'my-value');

            expect(mockKeytar.setPassword).toHaveBeenCalledWith('kageops', 'test-account', 'my-value');
        });
    });

    describe('deleteSecret()', () => {
        it('calls keytar.deletePassword', async () => {
            const { deleteSecret } = await import('../../src/main/secret-store');
            await deleteSecret('kageops', 'test-account');

            expect(mockKeytar.deletePassword).toHaveBeenCalledWith('kageops', 'test-account');
        });

        it('does not throw when deletePassword fails', async () => {
            mockKeytar.deletePassword.mockRejectedValueOnce(new Error('not found'));

            const { deleteSecret } = await import('../../src/main/secret-store');
            await expect(deleteSecret('kageops', 'test')).resolves.toBeUndefined();
        });
    });

    describe('getApiKey()', () => {
        it('maps claude to anthropic-api-key account', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce('sk-ant-xxx');

            const { getApiKey } = await import('../../src/main/secret-store');
            const result = await getApiKey('claude');

            expect(result).toBe('sk-ant-xxx');
            expect(mockKeytar.getPassword).toHaveBeenCalledWith('kageops', 'anthropic-api-key');
        });

        it('maps openrouter to openrouter-api-key account', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce('sk-or-xxx');

            const { getApiKey } = await import('../../src/main/secret-store');
            const result = await getApiKey('openrouter');

            expect(result).toBe('sk-or-xxx');
            expect(mockKeytar.getPassword).toHaveBeenCalledWith('kageops', 'openrouter-api-key');
        });

        it('maps openai to openai-api-key account', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce('sk-xxx');

            const { getApiKey } = await import('../../src/main/secret-store');
            const result = await getApiKey('openai');

            expect(result).toBe('sk-xxx');
            expect(mockKeytar.getPassword).toHaveBeenCalledWith('kageops', 'openai-api-key');
        });

        it('maps gemini to gemini-api-key account', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce('gemini-xxx');

            const { getApiKey } = await import('../../src/main/secret-store');
            const result = await getApiKey('gemini');

            expect(result).toBe('gemini-xxx');
            expect(mockKeytar.getPassword).toHaveBeenCalledWith('kageops', 'gemini-api-key');
        });

        it('looks up ollama key from keychain (cloud support)', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce('ollama-cloud-key');

            const { getApiKey } = await import('../../src/main/secret-store');
            const result = await getApiKey('ollama');

            expect(result).toBe('ollama-cloud-key');
            expect(mockKeytar.getPassword).toHaveBeenCalledWith('kageops', 'ollama-api-key');
        });

        it('falls back to env var when keytar returns null', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce(null);

            const originalEnv = process.env.ANTHROPIC_API_KEY;
            process.env.ANTHROPIC_API_KEY = 'env-key-123';

            try {
                const { getApiKey } = await import('../../src/main/secret-store');
                const result = await getApiKey('claude');
                expect(result).toBe('env-key-123');
            } finally {
                if (originalEnv === undefined) {
                    delete process.env.ANTHROPIC_API_KEY;
                } else {
                    process.env.ANTHROPIC_API_KEY = originalEnv;
                }
            }
        });

        it('falls back to env var when keytar getPassword throws', async () => {
            mockKeytar.getPassword.mockRejectedValueOnce(new Error('keytar broken'));

            const originalEnv = process.env.OPENAI_API_KEY;
            process.env.OPENAI_API_KEY = 'env-openai-key';

            try {
                const { getApiKey } = await import('../../src/main/secret-store');
                const result = await getApiKey('openai');
                expect(result).toBe('env-openai-key');
            } finally {
                if (originalEnv === undefined) {
                    delete process.env.OPENAI_API_KEY;
                } else {
                    process.env.OPENAI_API_KEY = originalEnv;
                }
            }
        });

        it('returns null when neither keytar nor env var has a key', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce(null);

            const originalEnv = process.env.OPENROUTER_API_KEY;
            delete process.env.OPENROUTER_API_KEY;

            try {
                const { getApiKey } = await import('../../src/main/secret-store');
                const result = await getApiKey('openrouter');
                expect(result).toBeNull();
            } finally {
                if (originalEnv !== undefined) {
                    process.env.OPENROUTER_API_KEY = originalEnv;
                }
            }
        });
    });

    // ── F-313: env-fallback gating ──────────────────────────────────────────
    //
    // shouldAllowEnvKeyFallback() decides whether process.env values get used
    // when keychain is empty. Default behaviour:
    //   - non-Electron (vitest, headless runner): env fallback ON
    //   - Electron app:                            env fallback OFF
    //   - KAGEOPS_ALLOW_ENV_KEYS=1                 force ON
    //   - KAGEOPS_ALLOW_ENV_KEYS=0                 force OFF
    //
    // We can't realistically simulate Electron in a vitest run (process.versions
    // .electron is read-only at the OS level), but we CAN exercise the explicit
    // override paths.
    describe('shouldAllowEnvKeyFallback() — F-313', () => {
        it('returns true when KAGEOPS_ALLOW_ENV_KEYS=1', async () => {
            const original = process.env.KAGEOPS_ALLOW_ENV_KEYS;
            process.env.KAGEOPS_ALLOW_ENV_KEYS = '1';
            try {
                const { shouldAllowEnvKeyFallback } = await import('../../src/main/secret-store');
                expect(shouldAllowEnvKeyFallback()).toBe(true);
            } finally {
                if (original === undefined) delete process.env.KAGEOPS_ALLOW_ENV_KEYS;
                else process.env.KAGEOPS_ALLOW_ENV_KEYS = original;
            }
        });

        it('returns false when KAGEOPS_ALLOW_ENV_KEYS=0', async () => {
            const original = process.env.KAGEOPS_ALLOW_ENV_KEYS;
            process.env.KAGEOPS_ALLOW_ENV_KEYS = '0';
            try {
                const { shouldAllowEnvKeyFallback } = await import('../../src/main/secret-store');
                expect(shouldAllowEnvKeyFallback()).toBe(false);
            } finally {
                if (original === undefined) delete process.env.KAGEOPS_ALLOW_ENV_KEYS;
                else process.env.KAGEOPS_ALLOW_ENV_KEYS = original;
            }
        });

        it('returns true under vitest (non-Electron) when no override is set', async () => {
            const original = process.env.KAGEOPS_ALLOW_ENV_KEYS;
            delete process.env.KAGEOPS_ALLOW_ENV_KEYS;
            try {
                const { shouldAllowEnvKeyFallback } = await import('../../src/main/secret-store');
                // process.versions.electron is undefined in vitest — so the
                // heuristic returns true. This preserves existing CI/CLI
                // behaviour where env vars are still the natural config path.
                expect(shouldAllowEnvKeyFallback()).toBe(true);
            } finally {
                if (original !== undefined) process.env.KAGEOPS_ALLOW_ENV_KEYS = original;
            }
        });

        it('getApiKey() returns null when fallback is force-disabled and keychain is empty', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce(null);
            const originalKey = process.env.ANTHROPIC_API_KEY;
            const originalFlag = process.env.KAGEOPS_ALLOW_ENV_KEYS;
            process.env.ANTHROPIC_API_KEY = 'env-key-should-be-ignored';
            process.env.KAGEOPS_ALLOW_ENV_KEYS = '0';

            try {
                const { getApiKey } = await import('../../src/main/secret-store');
                const result = await getApiKey('claude');
                expect(result).toBeNull();
            } finally {
                if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
                else process.env.ANTHROPIC_API_KEY = originalKey;
                if (originalFlag === undefined) delete process.env.KAGEOPS_ALLOW_ENV_KEYS;
                else process.env.KAGEOPS_ALLOW_ENV_KEYS = originalFlag;
            }
        });

        it('getApiKey() prefers keychain even when env var is set + fallback enabled', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce('keychain-wins');
            const originalKey = process.env.ANTHROPIC_API_KEY;
            const originalFlag = process.env.KAGEOPS_ALLOW_ENV_KEYS;
            process.env.ANTHROPIC_API_KEY = 'env-loses';
            process.env.KAGEOPS_ALLOW_ENV_KEYS = '1';

            try {
                const { getApiKey } = await import('../../src/main/secret-store');
                const result = await getApiKey('claude');
                expect(result).toBe('keychain-wins');
            } finally {
                if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
                else process.env.ANTHROPIC_API_KEY = originalKey;
                if (originalFlag === undefined) delete process.env.KAGEOPS_ALLOW_ENV_KEYS;
                else process.env.KAGEOPS_ALLOW_ENV_KEYS = originalFlag;
            }
        });
    });

    describe('setApiKey()', () => {
        it('stores key via keytar.setPassword', async () => {
            const { setApiKey } = await import('../../src/main/secret-store');
            await setApiKey('claude', 'sk-ant-new');

            expect(mockKeytar.setPassword).toHaveBeenCalledWith('kageops', 'anthropic-api-key', 'sk-ant-new');
        });

        it('stores ollama key via keytar (cloud support)', async () => {
            const { setApiKey } = await import('../../src/main/secret-store');
            await setApiKey('ollama', 'ollama-cloud-key');

            expect(mockKeytar.setPassword).toHaveBeenCalledWith('kageops', 'ollama-api-key', 'ollama-cloud-key');
        });
    });

    describe('hasApiKey()', () => {
        it('returns true when keychain has a key', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce('sk-exists');

            const { hasApiKey } = await import('../../src/main/secret-store');
            const result = await hasApiKey('claude');

            expect(result).toBe(true);
        });

        it('returns false when no key exists anywhere', async () => {
            mockKeytar.getPassword.mockResolvedValueOnce(null);

            const originalEnv = process.env.ANTHROPIC_API_KEY;
            delete process.env.ANTHROPIC_API_KEY;

            try {
                const { hasApiKey } = await import('../../src/main/secret-store');
                const result = await hasApiKey('claude');
                expect(result).toBe(false);
            } finally {
                if (originalEnv !== undefined) {
                    process.env.ANTHROPIC_API_KEY = originalEnv;
                }
            }
        });
    });

    describe('getApiKeyStatus()', () => {
        it('returns status for all 5 providers', async () => {
            mockKeytar.getPassword.mockResolvedValue(null);

            const { getApiKeyStatus } = await import('../../src/main/secret-store');
            const status = await getApiKeyStatus();

            expect(status).toHaveProperty('claude');
            expect(status).toHaveProperty('openrouter');
            expect(status).toHaveProperty('openai');
            expect(status).toHaveProperty('gemini');
            expect(status).toHaveProperty('ollama');
            expect(Object.keys(status)).toHaveLength(5);
        });

        it('reports ollama status based on keychain/env', async () => {
            mockKeytar.getPassword.mockResolvedValue(null);

            const { getApiKeyStatus } = await import('../../src/main/secret-store');
            const status = await getApiKeyStatus();

            // No key in keychain or env → false
            expect(status.ollama).toBe(false);
        });
    });
});
