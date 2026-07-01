/**
 * Provider API key resolution.
 *
 * Priority: explicit key from config → provider_keys registry (DB) →
 * secret-store (OS Keychain) → env var fallback. Registry lookup is
 * skipped and disabled for the session on the first failure so that
 * startup paths without a live DB don't keep retrying.
 *
 * The env-var fallback is what makes the headless CLI and `npm run`
 * paths work — those contexts can't reach the OS keychain (which is
 * Electron-main-only), so they rely on `.env` / `process.env` for
 * provider auth. Without this fallback the CLI would emit HTTP 401
 * on every provider call even when the operator has the right keys
 * sitting in their `.env`.
 */

import { getApiKey } from '../../main/secret-store';
import type { AiProvider } from './types';

let registryAvailable = true;

/**
 * Conventional env-var name per provider. Mirrors the mapping used by
 * `config:save-env-var` in src/main/main.ts so the CLI and the app
 * read from the same names. `claude-cli` / `codex-cli` are
 * subscription-based and don't normally need a key, but if the
 * operator has set ANTHROPIC_API_KEY / OPENAI_API_KEY for fallback
 * routing we honour them here.
 */
const ENV_VAR_BY_PROVIDER: Record<AiProvider, readonly string[]> = {
    claude: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    'claude-cli': ['ANTHROPIC_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    'codex-cli': ['OPENAI_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    ollama: ['OLLAMA_API_KEY'],
};

function resolveFromEnv(provider: AiProvider): string | null {
    const names = ENV_VAR_BY_PROVIDER[provider] ?? [];
    for (const name of names) {
        const val = process.env[name];
        if (val !== undefined && val !== '') return val;
    }
    return null;
}

export async function resolveProviderApiKey(
    provider: AiProvider,
    explicitKey?: string
): Promise<string | null> {
    if (explicitKey !== undefined && explicitKey !== '') return explicitKey;

    // Env wins over DB registry + keychain. Rationale: a key set in
    // process.env (or .env that the runner loaded) is the operator's
    // most recent, deliberate signal. The DB registry + OS keychain
    // may carry stale entries from a previous install or test session,
    // and silently using those when the operator just typed a fresh
    // key in .env produces baffling HTTP 401s (a stale keychain entry
    // shadowing a valid .env key is a real, hard-to-diagnose failure
    // mode). Explicit > stored stays the priority.
    const envKey = resolveFromEnv(provider);
    if (envKey !== null) return envKey;

    if (registryAvailable) {
        try {
            const { resolveDefaultKey } = await import('../../main/provider-key-registry');
            const registryKey = await resolveDefaultKey(provider);
            if (registryKey !== null && registryKey !== '') return registryKey;
        } catch {
            // DB not ready (startup, tests) — skip registry for this session
            registryAvailable = false;
        }
    }

    const storeKey = await getApiKey(provider).catch(() => null);
    if (storeKey !== null && storeKey !== '') return storeKey;

    return null;
}
