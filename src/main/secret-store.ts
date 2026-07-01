/**
 * KageOps Secret Store
 *
 * Provides OS Keychain-backed secret storage for API keys and credentials.
 * Uses `keytar` for OS-level credential storage (Windows Credential Manager,
 * macOS Keychain, Linux libsecret). Falls back to environment variables
 * when keytar is unavailable (CI, headless environments).
 */

import type { AiProvider } from '../agents/ai-adapter';
import { createLogger } from '../shared/logger';
import { isAzureKeyVaultEnabled, getSecretFromKeyVault, setSecretInKeyVault } from './azure-keyvault-stub';

// ── Extended provider type including GitHub ───────────
export type SecretProvider = AiProvider | 'github';

const log = createLogger('SecretStore');

// ── Constants ────────────────────────────────────────

const SERVICE_NAME = 'kageops';

const PROVIDER_ACCOUNT_MAP: Record<string, string | null> = {
    claude: 'anthropic-api-key',
    openrouter: 'openrouter-api-key',
    openai: 'openai-api-key',
    gemini: 'gemini-api-key',
    ollama: 'ollama-api-key',   // Ollama cloud requires API key
    github: 'github-pat',
};

const PROVIDER_ENV_MAP: Record<string, string> = {
    claude: 'ANTHROPIC_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GOOGLE_API_KEY',
    ollama: 'OLLAMA_API_KEY',
    github: 'GITHUB_TOKEN',
};

// ── Keytar Lazy Loader ───────────────────────────────

type Keytar = {
    getPassword: (service: string, account: string) => Promise<string | null>;
    setPassword: (service: string, account: string, password: string) => Promise<void>;
    deletePassword: (service: string, account: string) => Promise<boolean>;
    findPassword: (service: string) => Promise<string | null>;
};

let keytarModule: Keytar | null = null;
let keytarLoadAttempted = false;
let keytarLoadError: string | null = null;

async function loadKeytar(): Promise<Keytar | null> {
    if (keytarLoadAttempted) {
        return keytarModule;
    }
    keytarLoadAttempted = true;

    try {
        // Dynamic import — keytar is a real dependency now (was previously
        // listed as @ts-expect-error optional, but every shipping build had
        // the keychain code path silently broken because the package was
        // never declared). Native module — must be `asarUnpack`ed in
        // electron-builder.yml so the `.node` binary is on the filesystem
        // and not inside the asar archive.
        //
        // F-346: in plain-Node (tsx CLI) contexts, keytar's native binding
        // may be built for Electron's Node ABI and fail to load with a
        // version-mismatch error. The catch below preserves the existing
        // env-var fallback path but now stores the exact load error so the
        // diagnostic helper can surface it instead of "not available".
        const kt = await import('keytar') as Keytar;
        keytarModule = kt;
        return keytarModule;
    } catch (err) {
        keytarLoadError = err instanceof Error ? err.message : String(err);
        log.warn(
            { err: keytarLoadError },
            'keytar not available — provider keys must come from env or .env. ' +
            'In CLI contexts, this usually means the keytar native binding was built ' +
            'against Electron and can\'t load in plain Node. Run `npm rebuild keytar` ' +
            'in your CLI environment, OR put your keys in .env / process.env.'
        );
        return null;
    }
}

/**
 * F-346: diagnostic helper — returns whether the keychain is reachable
 * from this process plus the raw load error if it isn't. Useful from a
 * boot-time log line ("Keychain: reachable" / "Keychain: unreachable —
 * <reason>") so operators get fast feedback rather than discovering the
 * gap via HTTP 401 mid-run.
 */
export async function probeKeychainReachable(): Promise<{
    readonly reachable: boolean;
    readonly error: string | null;
}> {
    const kt = await loadKeytar();
    if (kt === null) {
        return { reachable: false, error: keytarLoadError };
    }
    // Touching the keychain with a no-op read confirms the OS surface is
    // actually accessible (vs. binding loaded but libsecret missing).
    try {
        await kt.findPassword(SERVICE_NAME);
        return { reachable: true, error: null };
    } catch (err) {
        return { reachable: false, error: err instanceof Error ? err.message : String(err) };
    }
}

// ── Generic Secret Operations ────────────────────────

/**
 * Get a secret from the OS Keychain.
 */
export async function getSecret(service: string, account: string): Promise<string | null> {
    const keytar = await loadKeytar();
    if (keytar === null) {
        return null;
    }

    try {
        return await keytar.getPassword(service, account);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ account, err: msg }, 'Failed to get secret');
        return null;
    }
}

/**
 * Store a secret in the OS Keychain.
 */
export async function setSecret(service: string, account: string, value: string): Promise<void> {
    const keytar = await loadKeytar();
    if (keytar === null) {
        throw new Error(
            '[SecretStore] keytar not available — cannot store secrets. ' +
            'Set the corresponding environment variable instead.'
        );
    }

    await keytar.setPassword(service, account, value);
    log.info({ account }, 'Stored secret');
}

/**
 * Delete a secret from the OS Keychain.
 */
export async function deleteSecret(service: string, account: string): Promise<void> {
    const keytar = await loadKeytar();
    if (keytar === null) {
        return;
    }

    try {
        await keytar.deletePassword(service, account);
        log.info({ account }, 'Deleted secret');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ account, err: msg }, 'Failed to delete secret');
    }
}

// ── Provider-Specific API Key Operations ─────────────

/**
 * Should env-var fallback be used when keychain is empty?
 *
 * Decision #74 (F-313): default is OFF for production. End users typing keys
 * into the API Keys panel get keychain values that are authoritative. Stray
 * shell or .env values can no longer override what the user explicitly stored.
 *
 * Override rules (highest first):
 *   - `KAGEOPS_ALLOW_ENV_KEYS=1`  → force-on (CI / headless / dev convenience)
 *   - `KAGEOPS_ALLOW_ENV_KEYS=0`  → force-off (extra-safe, even in dev)
 *   - else: ON when running outside Electron (CLI/tests), OFF when inside
 *           the Electron app (UI users get keychain-only behaviour)
 *
 * The Electron-detection heuristic is `process.versions.electron` — present
 * when running under the Electron runtime. Plain Node (headless runner,
 * vitest) lacks this property, so they keep env-var fallback by default.
 */
export function shouldAllowEnvKeyFallback(): boolean {
    const override = process.env['KAGEOPS_ALLOW_ENV_KEYS'];
    if (override === '1') return true;
    if (override === '0') return false;
    // Default: env fallback ON for non-Electron (CI/CLI/tests),
    // OFF inside the Electron app (UI users own their keys).
    return process.versions.electron === undefined;
}

/**
 * Get an API key for a provider.
 *
 * Priority:
 *   1. Azure Key Vault (cloud/headless mode only)
 *   2. OS Keychain — what the API Keys panel writes to (authoritative)
 *   3. Environment variable — fallback, gated by shouldAllowEnvKeyFallback().
 *      Disabled by default in the Electron app to prevent stale shell vars
 *      from silently overriding what the user typed in the panel.
 */
export async function getApiKey(provider: SecretProvider): Promise<string | null> {
    const account = PROVIDER_ACCOUNT_MAP[provider];
    if (account === null || account === undefined) {
        return null; // Provider doesn't need a key (e.g., ollama)
    }

    // Azure Key Vault takes priority in cloud/headless mode
    if (isAzureKeyVaultEnabled()) {
        const kvValue = await getSecretFromKeyVault(account);
        if (kvValue !== null && kvValue !== '') {
            return kvValue;
        }
    }

    // Try OS Keychain — authoritative for end users
    const keychainValue = await getSecret(SERVICE_NAME, account);
    if (keychainValue !== null && keychainValue !== '') {
        return keychainValue;
    }

    // Env var fallback — opt-in for production users (decision #74).
    if (shouldAllowEnvKeyFallback()) {
        const envVar = PROVIDER_ENV_MAP[provider];
        if (envVar !== undefined) {
            const envValue = process.env[envVar];
            if (envValue !== undefined && envValue !== '') {
                return envValue;
            }
        }
    }

    return null;
}

/**
 * Store an API key for a provider in the OS Keychain.
 */
export async function setApiKey(provider: SecretProvider, key: string): Promise<void> {
    const account = PROVIDER_ACCOUNT_MAP[provider];
    if (account === null || account === undefined) {
        throw new Error(`[SecretStore] Provider "${provider}" does not use an API key.`);
    }

    if (isAzureKeyVaultEnabled()) {
        await setSecretInKeyVault(account, key);
        return;
    }

    await setSecret(SERVICE_NAME, account, key);
}

/**
 * Check if an API key exists for a provider (keychain or env var).
 */
export async function hasApiKey(provider: SecretProvider): Promise<boolean> {
    const key = await getApiKey(provider);
    return key !== null && key !== '';
}

/**
 * Delete an API key for a provider from the OS Keychain.
 */
export async function deleteApiKey(provider: SecretProvider): Promise<void> {
    const account = PROVIDER_ACCOUNT_MAP[provider];
    if (account === null || account === undefined) {
        return; // Provider has no stored key (e.g., ollama)
    }
    await deleteSecret(SERVICE_NAME, account);
}

/**
 * Get API key status for all providers.
 */
export async function getApiKeyStatus(): Promise<Record<string, boolean>> {
    const providers: AiProvider[] = ['claude', 'openrouter', 'openai', 'gemini', 'ollama'];
    const status: Record<string, boolean> = {};

    for (const provider of providers) {
        status[provider] = await hasApiKey(provider);
    }

    return status;
}
