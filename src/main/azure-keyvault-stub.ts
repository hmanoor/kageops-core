/**
 * Azure Key Vault Integration
 *
 * Reads and writes secrets from Azure Key Vault when AZURE_KEYVAULT_URI is set.
 * Uses DefaultAzureCredential — works with:
 *   - Managed Identity (ACI production)
 *   - AZURE_CLIENT_ID / AZURE_CLIENT_SECRET env vars (CI/CD)
 *   - `az login` (local development)
 *
 * Falls back to environment variables when Key Vault is not configured.
 */

import { createLogger } from '../shared/logger';

const log = createLogger('AzureKeyVault');

const KEYVAULT_URI = process.env['AZURE_KEYVAULT_URI'];

// Maps our internal secret names to Azure Key Vault secret names
const SECRET_NAME_MAP: Record<string, string> = {
    'anthropic-api-key': 'anthropic-api-key',
    'openrouter-api-key': 'openrouter-api-key',
    'openai-api-key': 'openai-api-key',
    'gemini-api-key': 'gemini-api-key',
    'github-pat': 'github-pat',
};

// Env var fallbacks for each secret
const SECRET_ENV_MAP: Record<string, string> = {
    'anthropic-api-key': 'ANTHROPIC_API_KEY',
    'openrouter-api-key': 'OPENROUTER_API_KEY',
    'openai-api-key': 'OPENAI_API_KEY',
    'gemini-api-key': 'GOOGLE_API_KEY',
    'github-pat': 'GITHUB_TOKEN',
};

// Lazy-loaded SDK clients — avoids import cost when Key Vault is not used
let secretClientPromise: Promise<import('@azure/keyvault-secrets').SecretClient> | null = null;

function getSecretClient(): Promise<import('@azure/keyvault-secrets').SecretClient> {
    if (secretClientPromise === null) {
        secretClientPromise = (async () => {
            const { SecretClient } = await import('@azure/keyvault-secrets');
            const { DefaultAzureCredential } = await import('@azure/identity');
            const client = new SecretClient(KEYVAULT_URI!, new DefaultAzureCredential());
            log.info({ vault: KEYVAULT_URI }, 'Azure Key Vault client initialised');
            return client;
        })();
    }
    return secretClientPromise;
}

/**
 * Returns true when Azure Key Vault mode is active (AZURE_KEYVAULT_URI is set).
 */
export function isAzureKeyVaultEnabled(): boolean {
    return KEYVAULT_URI !== undefined && KEYVAULT_URI !== '';
}

/**
 * Get a secret from Azure Key Vault.
 * Falls back to environment variables if Key Vault is unavailable or the
 * secret is not found.
 */
export async function getSecretFromKeyVault(secretName: string): Promise<string | null> {
    if (!isAzureKeyVaultEnabled()) return null;

    const kvName = SECRET_NAME_MAP[secretName] ?? secretName;

    try {
        const client = await getSecretClient();
        const secret = await client.getSecret(kvName);
        if (secret.value !== undefined && secret.value !== '') {
            log.debug({ secretName: kvName }, 'Secret retrieved from Key Vault');
            return secret.value;
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ secretName: kvName, vault: KEYVAULT_URI, err: msg },
            'Key Vault read failed — falling back to env var');
    }

    // Env var fallback
    const envVar = SECRET_ENV_MAP[kvName];
    if (envVar !== undefined) {
        const value = process.env[envVar];
        if (value !== undefined && value !== '') {
            log.debug({ secretName: kvName, envVar }, 'Secret resolved from env var fallback');
            return value;
        }
    }

    log.warn({ secretName: kvName, vault: KEYVAULT_URI }, 'Secret not found in Key Vault or env');
    return null;
}

/**
 * Store a secret in Azure Key Vault.
 */
export async function setSecretInKeyVault(secretName: string, value: string): Promise<void> {
    if (!isAzureKeyVaultEnabled()) return;

    const kvName = SECRET_NAME_MAP[secretName] ?? secretName;

    try {
        const client = await getSecretClient();
        await client.setSecret(kvName, value);
        log.info({ secretName: kvName, vault: KEYVAULT_URI }, 'Secret written to Key Vault');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ secretName: kvName, vault: KEYVAULT_URI, err: msg },
            'Failed to write secret to Key Vault');
        throw new Error(`Key Vault write failed for "${kvName}": ${msg}`);
    }
}
