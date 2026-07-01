/**
 * ModelFallbackChain unit tests
 *
 * Tests the chain execution logic: primary success, fallback triggering,
 * auth error handling, and chain exhaustion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AiResponse } from '../../src/agents/ai-adapter';
import {
    executeFallbackChain,
    getFallbackChain,
    DEFAULT_FALLBACK_CHAINS,
} from '../../src/agents/model-fallback';
import type { FallbackChainConfig } from '../../src/agents/model-fallback';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResponse(model: string): AiResponse {
    return {
        text: `Response from ${model}`,
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.01,
        model,
        durationMs: 500,
    };
}

const TEST_CHAIN: FallbackChainConfig = {
    models: [
        { model: 'claude/claude-sonnet-4-20250514', retryOptions: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50 } },
        { model: 'openai/gpt-4o', retryOptions: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50 } },
        { model: 'ollama/llama3.2', retryOptions: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50 } },
    ],
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ModelFallbackChain', () => {

    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // ── executeFallbackChain ─────────────────────────────────────────────────

    describe('executeFallbackChain()', () => {
        it('returns primary model result when it succeeds', async () => {
            const callFn = vi.fn(async (model: string) => makeResponse(model));

            const result = await executeFallbackChain(TEST_CHAIN, callFn);

            expect(result.modelUsed).toBe('claude/claude-sonnet-4-20250514');
            expect(result.modelIndex).toBe(0);
            expect(result.response.text).toContain('claude');
            expect(callFn).toHaveBeenCalledTimes(1);
        });

        it('falls back to secondary when primary rate-limited', async () => {
            const callFn = vi.fn(async (model: string) => {
                if (model.startsWith('claude')) {
                    throw new Error('HTTP 429: Rate limit exceeded');
                }
                return makeResponse(model);
            });

            const result = await executeFallbackChain(TEST_CHAIN, callFn);

            expect(result.modelUsed).toBe('openai/gpt-4o');
            expect(result.modelIndex).toBe(1);
            expect(result.response.text).toContain('gpt-4o');
        });

        it('falls back to tertiary when primary and secondary fail', async () => {
            const callFn = vi.fn(async (model: string) => {
                if (model.startsWith('claude')) throw new Error('HTTP 500: Server Error');
                if (model.startsWith('openai')) throw new Error('HTTP 503: Service Unavailable');
                return makeResponse(model);
            });

            const result = await executeFallbackChain(TEST_CHAIN, callFn);

            expect(result.modelUsed).toBe('ollama/llama3.2');
            expect(result.modelIndex).toBe(2);
        });

        it('throws when all models in chain fail', async () => {
            const callFn = vi.fn(async () => {
                throw new Error('HTTP 500: Always fails');
            });

            await expect(
                executeFallbackChain(TEST_CHAIN, callFn)
            ).rejects.toThrow('All 3 model(s) in fallback chain failed');
        });

        it('stops chain on client error (bad request)', async () => {
            const callFn = vi.fn(async () => {
                throw new Error('HTTP 400: Bad Request — invalid prompt');
            });

            await expect(
                executeFallbackChain(TEST_CHAIN, callFn)
            ).rejects.toThrow();

            // Client error is not retryable, so only 1 call to primary (no retries, no fallbacks)
            expect(callFn).toHaveBeenCalledTimes(1);
        });

        it('falls back to different provider on auth error', async () => {
            // Claude auth fails → tries OpenAI (different provider) → succeeds
            const callFn = vi.fn(async (model: string) => {
                if (model.startsWith('claude')) {
                    throw new Error('HTTP 401: Unauthorized — invalid API key');
                }
                return makeResponse(model);
            });

            const result = await executeFallbackChain(TEST_CHAIN, callFn);

            expect(result.modelUsed).toBe('openai/gpt-4o');
        });

        it('stops chain on auth error within same provider', async () => {
            const sameProviderChain: FallbackChainConfig = {
                models: [
                    { model: 'claude/claude-sonnet-4-20250514', retryOptions: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50 } },
                    { model: 'claude/claude-haiku-3-5-20241022', retryOptions: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50 } },
                ],
            };

            const callFn = vi.fn(async () => {
                throw new Error('HTTP 401: Unauthorized');
            });

            await expect(
                executeFallbackChain(sameProviderChain, callFn)
            ).rejects.toThrow();

            // Should only try the first model, not the second (same provider)
            expect(callFn).toHaveBeenCalledTimes(1);
        });

        it('throws on empty chain', async () => {
            const callFn = vi.fn(async () => makeResponse('test'));

            await expect(
                executeFallbackChain({ models: [] }, callFn)
            ).rejects.toThrow('Fallback chain is empty');
        });

        it('tracks total attempts across the chain', async () => {
            let callCount = 0;
            const callFn = vi.fn(async (model: string) => {
                callCount++;
                if (model.startsWith('claude')) throw new Error('HTTP 500: down');
                if (model.startsWith('openai') && callCount <= 3) throw new Error('HTTP 500: also down');
                return makeResponse(model);
            });

            const result = await executeFallbackChain(TEST_CHAIN, callFn);

            expect(result.totalAttempts).toBeGreaterThan(2);
        });

        it('uses per-model retry options', async () => {
            const chain: FallbackChainConfig = {
                models: [
                    { model: 'claude/test', retryOptions: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50 } },
                    { model: 'openai/test', retryOptions: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50 } },
                ],
            };

            const callFn = vi.fn(async (model: string) => {
                if (model.startsWith('claude')) throw new Error('HTTP 500');
                return makeResponse(model);
            });

            const result = await executeFallbackChain(chain, callFn);

            // Primary: 1 attempt (0 retries), then falls back
            // Secondary: 1 attempt (succeeds)
            expect(callFn).toHaveBeenCalledTimes(2);
            expect(result.modelUsed).toBe('openai/test');
        });
    });

    // ── getFallbackChain ────────────────────────────────────────────────────

    describe('getFallbackChain()', () => {
        it('returns default chain for known agents', () => {
            const chain = getFallbackChain('forge');
            expect(chain.models.length).toBeGreaterThanOrEqual(2);
            expect(chain.models[0].model).toContain('ollama');
        });

        it('returns at least one model chain for unknown agents', () => {
            const chain = getFallbackChain('unknown-agent');
            expect(chain.models.length).toBeGreaterThanOrEqual(1);
        });

        it('uses custom chains when provided', () => {
            const custom = {
                forge: { models: [{ model: 'ollama/custom' }] },
            };
            const chain = getFallbackChain('forge', undefined, custom);
            expect(chain.models[0].model).toBe('ollama/custom');
        });

        it('falls back to default when agent not in custom chains', () => {
            const custom = {
                forge: { models: [{ model: 'ollama/custom' }] },
            };
            const chain = getFallbackChain('scout', undefined, custom);
            expect(chain.models[0].model).toContain('ollama');
        });

        it('prepends the agent primary model when provided', () => {
            const chain = getFallbackChain('forge', 'openrouter/anthropic/claude-sonnet-4');
            expect(chain.models[0].model).toBe('openrouter/anthropic/claude-sonnet-4');
            expect(chain.models.length).toBeGreaterThanOrEqual(3);
        });

        it('dedupes primary model against the base chain', () => {
            const primary = DEFAULT_FALLBACK_CHAINS['forge'].models[0].model;
            const chain = getFallbackChain('forge', primary);
            const occurrences = chain.models.filter((m) => m.model === primary).length;
            expect(occurrences).toBe(1);
            expect(chain.models[0].model).toBe(primary);
        });
    });

    // ── DEFAULT_FALLBACK_CHAINS ─────────────────────────────────────────────

    describe('DEFAULT_FALLBACK_CHAINS', () => {
        it('has entries for all agents', () => {
            const agents = ['sensei', 'scout', 'blueprint', 'forge', 'vigil', 'aegis', 'pixel', 'cipher', 'herald'];
            for (const agent of agents) {
                expect(DEFAULT_FALLBACK_CHAINS[agent]).toBeDefined();
                expect(DEFAULT_FALLBACK_CHAINS[agent].models.length).toBeGreaterThanOrEqual(2);
            }
        });

        it('uses Ollama cloud as primary for all agents', () => {
            for (const chain of Object.values(DEFAULT_FALLBACK_CHAINS)) {
                expect(chain.models[0].model).toContain('ollama');
            }
        });

        it('includes Claude as cross-provider fallback for all agents', () => {
            for (const chain of Object.values(DEFAULT_FALLBACK_CHAINS)) {
                const lastModel = chain.models[chain.models.length - 1].model;
                expect(lastModel).toContain('claude');
            }
        });
    });
});
