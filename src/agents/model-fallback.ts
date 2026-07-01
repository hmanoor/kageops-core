/**
 * KageOps Model Fallback Chain
 *
 * Tries AI models in order — primary, then fallbacks — using retry policy
 * per model. Falls back on rate limit exhaustion, server errors, and timeouts.
 * Auth errors stop the chain immediately (no fallback will help).
 */

import { AiResponse } from './ai-adapter';
import { executeWithRetry, classifyError, isRetryableError, RetryOptions } from './retry-policy';
import { createLogger } from '../shared/logger';

const log = createLogger('ModelFallback');

// ── Types ────────────────────────────────────────────

export interface FallbackChainEntry {
    readonly model: string;
    readonly retryOptions?: Partial<RetryOptions>;
}

export interface FallbackChainConfig {
    readonly models: readonly FallbackChainEntry[];
}

export interface FallbackResult {
    readonly response: AiResponse;
    readonly modelUsed: string;
    readonly modelIndex: number;
    readonly totalAttempts: number;
}

// ── Default Fallback Chains ──────────────────────────

// ── Default models ──────────────────────────────────────────────────────────
// Ollama cloud: lighter models for speed. Cross-provider fallback to Claude API.
const OLLAMA_GENERAL  = 'ollama/gpt-oss:120b-cloud';            // general tasks
const OLLAMA_CODER    = 'ollama/glm-5.1:cloud';                 // coding (#1 SWE-Bench Pro)
const OLLAMA_FAST     = 'ollama/devstral-small-2:24b-cloud';    // fast review/support
const OLLAMA_BACKUP   = 'ollama/qwen3.5:9b';                    // fallback (local)
const CLAUDE_FALLBACK = 'claude/claude-haiku-3-5-20241022';     // cross-provider fallback

/**
 * Default fallback chains per agent.
 * Primary: Ollama cloud (lighter models). Final fallback: Claude API (different provider).
 * Coding agents use glm-5.1 → devstral → local → Claude.
 * General agents use gpt-oss:120b → local → Claude.
 */
export const DEFAULT_FALLBACK_CHAINS: Readonly<Record<string, FallbackChainConfig>> = {
    sensei: {
        models: [
            { model: OLLAMA_GENERAL },
            { model: OLLAMA_BACKUP },
            { model: CLAUDE_FALLBACK },
        ],
    },
    scout: {
        models: [
            { model: OLLAMA_GENERAL },
            { model: OLLAMA_BACKUP },
            { model: CLAUDE_FALLBACK },
        ],
    },
    blueprint: {
        models: [
            { model: 'ollama/qwen3-coder-next:cloud' },
            { model: OLLAMA_CODER },
            { model: CLAUDE_FALLBACK },
        ],
    },
    forge: {
        models: [
            { model: OLLAMA_CODER },
            { model: OLLAMA_FAST },
            { model: CLAUDE_FALLBACK },
        ],
    },
    vigil: {
        models: [
            { model: OLLAMA_FAST },
            { model: OLLAMA_GENERAL },
            { model: CLAUDE_FALLBACK },
        ],
    },
    aegis: {
        models: [
            { model: OLLAMA_FAST },
            { model: OLLAMA_GENERAL },
            { model: CLAUDE_FALLBACK },
        ],
    },
    pixel: {
        models: [
            { model: OLLAMA_GENERAL },
            { model: OLLAMA_BACKUP },
            { model: CLAUDE_FALLBACK },
        ],
    },
    cipher: {
        models: [
            { model: OLLAMA_FAST },
            { model: OLLAMA_CODER },
            { model: CLAUDE_FALLBACK },
        ],
    },
    herald: {
        models: [
            { model: OLLAMA_GENERAL },
            { model: OLLAMA_BACKUP },
            { model: CLAUDE_FALLBACK },
        ],
    },
};

// ── Fallback Execution ───────────────────────────────

/**
 * Execute an AI call through a fallback chain.
 *
 * For each model in the chain:
 * 1. Try the model with retry policy (exponential backoff)
 * 2. If all retries fail with retryable errors, move to next model
 * 3. If a non-retryable error occurs (auth, client), stop chain immediately
 *
 * @param chain - Ordered list of models to try
 * @param callFn - Function that calls the AI with a given model string
 * @returns FallbackResult with the response and which model was used
 */
export async function executeFallbackChain(
    chain: FallbackChainConfig,
    callFn: (model: string) => Promise<AiResponse>
): Promise<FallbackResult> {
    if (chain.models.length === 0) {
        throw new Error('Fallback chain is empty — at least one model is required.');
    }

    const chainErrors: Array<{ model: string; error: Error }> = [];
    let totalAttempts = 0;

    for (let i = 0; i < chain.models.length; i++) {
        const entry = chain.models[i];

        try {
            const result = await executeWithRetry(
                () => callFn(entry.model),
                {
                    maxRetries: entry.retryOptions?.maxRetries ?? 2,
                    baseDelayMs: entry.retryOptions?.baseDelayMs ?? 1000,
                    maxDelayMs: entry.retryOptions?.maxDelayMs ?? 15000,
                    ...entry.retryOptions,
                }
            );

            totalAttempts += result.attempts;

            return {
                response: result.value,
                modelUsed: entry.model,
                modelIndex: i,
                totalAttempts,
            };

        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            chainErrors.push({ model: entry.model, error: err });

            // Count attempts from the failed model
            totalAttempts += (entry.retryOptions?.maxRetries ?? 2) + 1;

            // If the root cause is not retryable, don't try fallbacks
            // Auth errors won't be fixed by a different model (unless it's a different provider)
            const classification = classifyError(err);
            if (classification === 'client-error') {
                // Client errors (bad request) stop the chain — the request itself is wrong
                break;
            }

            // Auth errors: check if next model is a different provider
            if (classification === 'auth-error' && i + 1 < chain.models.length) {
                const currentProvider = entry.model.split('/')[0];
                const nextProvider = chain.models[i + 1].model.split('/')[0];
                if (currentProvider === nextProvider) {
                    // Same provider — auth error won't be fixed by same provider's different model
                    break;
                }
                // Different provider — try it (might have valid credentials)
            } else if (classification === 'auth-error') {
                break;
            }

            // Retryable errors (rate limit, timeout, server) — try next model
            log.info({ model: entry.model, classification }, 'Model failed, trying next model in chain');
        }
    }

    // All models failed
    const details = chainErrors
        .map((e) => `  ${e.model}: ${e.error.message}`)
        .join('\n');
    throw new Error(
        `All ${chainErrors.length} model(s) in fallback chain failed:\n${details}`
    );
}

/**
 * Get the fallback chain config for an agent.
 * Returns the default chain if no custom one is configured.
 */
export function getFallbackChain(
    agentName: string,
    primaryModel?: string,
    customChains?: Readonly<Record<string, FallbackChainConfig>>
): FallbackChainConfig {
    const base =
        customChains !== undefined && customChains[agentName] !== undefined
            ? customChains[agentName]
            : DEFAULT_FALLBACK_CHAINS[agentName] ?? {
                  models: [{ model: OLLAMA_GENERAL }, { model: CLAUDE_FALLBACK }],
              };

    if (primaryModel === undefined || primaryModel === '') {
        return base;
    }

    // Prepend the agent's configured primary model, deduplicating against base.
    const deduped = base.models.filter((entry) => entry.model !== primaryModel);
    return { models: [{ model: primaryModel }, ...deduped] };
}
