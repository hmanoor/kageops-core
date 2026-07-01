/**
 * Tests for azure-keyvault-stub.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    }),
}));

// Mock the Azure SDK so CI (and local dev without `az login`) doesn't
// attempt real credential chains.
vi.mock('@azure/keyvault-secrets', () => ({
    SecretClient: class {
        getSecret = vi.fn(async () => ({ value: undefined }));
        setSecret = vi.fn(async () => ({}));
    },
}));
vi.mock('@azure/identity', () => ({
    DefaultAzureCredential: class {},
}));

// ── Tests ─────────────────────────────────────────────

describe('Azure Key Vault stub', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        // Restore env
        for (const key of Object.keys(process.env)) {
            if (!(key in originalEnv)) delete process.env[key];
        }
        Object.assign(process.env, originalEnv);
        vi.resetModules();
    });

    it('isAzureKeyVaultEnabled returns false when AZURE_KEYVAULT_URI is not set', async () => {
        delete process.env['AZURE_KEYVAULT_URI'];
        const { isAzureKeyVaultEnabled } = await import('../../src/main/azure-keyvault-stub');
        expect(isAzureKeyVaultEnabled()).toBe(false);
    });

    it('isAzureKeyVaultEnabled returns true when AZURE_KEYVAULT_URI is set', async () => {
        process.env['AZURE_KEYVAULT_URI'] = 'https://kageops-prod-kv.vault.azure.net/';
        const { isAzureKeyVaultEnabled } = await import('../../src/main/azure-keyvault-stub');
        expect(isAzureKeyVaultEnabled()).toBe(true);
    });

    it('getSecretFromKeyVault returns null when Key Vault is disabled', async () => {
        delete process.env['AZURE_KEYVAULT_URI'];
        const { getSecretFromKeyVault } = await import('../../src/main/azure-keyvault-stub');
        const result = await getSecretFromKeyVault('anthropic-api-key');
        expect(result).toBeNull();
    });

    it('getSecretFromKeyVault returns env var fallback when Key Vault is enabled', async () => {
        process.env['AZURE_KEYVAULT_URI'] = 'https://kageops-prod-kv.vault.azure.net/';
        process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
        const { getSecretFromKeyVault } = await import('../../src/main/azure-keyvault-stub');
        const result = await getSecretFromKeyVault('anthropic-api-key');
        expect(result).toBe('sk-ant-test-key');
    });

    it('getSecretFromKeyVault returns null when env var is not set', async () => {
        process.env['AZURE_KEYVAULT_URI'] = 'https://kageops-prod-kv.vault.azure.net/';
        delete process.env['ANTHROPIC_API_KEY'];
        const { getSecretFromKeyVault } = await import('../../src/main/azure-keyvault-stub');
        const result = await getSecretFromKeyVault('anthropic-api-key');
        expect(result).toBeNull();
    });

    it('setSecretInKeyVault is a no-op when Key Vault is disabled', async () => {
        delete process.env['AZURE_KEYVAULT_URI'];
        const { setSecretInKeyVault } = await import('../../src/main/azure-keyvault-stub');
        // Should not throw
        await expect(setSecretInKeyVault('anthropic-api-key', 'sk-test')).resolves.toBeUndefined();
    });

    it('setSecretInKeyVault logs intent without throwing when Key Vault is enabled (stub)', async () => {
        process.env['AZURE_KEYVAULT_URI'] = 'https://kageops-prod-kv.vault.azure.net/';
        const { setSecretInKeyVault } = await import('../../src/main/azure-keyvault-stub');
        // Stub just logs — should not throw
        await expect(setSecretInKeyVault('github-pat', 'ghp_test')).resolves.toBeUndefined();
    });
});
