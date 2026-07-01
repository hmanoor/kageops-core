/**
 * Direct unit tests for the provider dispatcher.
 *
 * The dispatcher is the switchboard that `sendPrompt` / `sendConversation`
 * delegate to after `withNetworkRetry`. It:
 *   - routes to the correct provider based on the parsed model string
 *   - short-circuits through the LiteLLM proxy when LITELLM_PROXY_URL is set
 *   - flattens multi-turn messages for providers without native chat support
 *
 * We mock every provider module so we can verify which one the dispatcher
 * called without touching the real HTTP/CLI layers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Provider module mocks ─────────────────────────────

const sendClaudePrompt = vi.fn(async () => ({
    text: 'claude-api',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    model: 'm',
    durationMs: 0,
}));
const sendClaudeConversation = vi.fn(async () => ({
    text: 'claude-api-conv',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    model: 'm',
    durationMs: 0,
}));
const sendClaudeCliPrompt = vi.fn(async () => ({
    text: 'claude-cli',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    model: 'claude-cli',
    durationMs: 0,
}));
const sendOpenAiPrompt = vi.fn(async () => ({
    text: 'openai',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    model: 'gpt-4o',
    durationMs: 0,
}));
const sendOpenRouterPrompt = vi.fn(async () => ({
    text: 'openrouter',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    model: 'or',
    durationMs: 0,
}));
const sendOllamaPrompt = vi.fn(async () => ({
    text: 'ollama',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    model: 'llama3.2',
    durationMs: 0,
}));
const sendOllamaConversation = vi.fn(async () => ({
    text: 'ollama-conv',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    model: 'llama3.2',
    durationMs: 0,
}));
const sendGeminiPrompt = vi.fn(async () => ({
    text: 'gemini',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    model: 'gemini',
    durationMs: 0,
}));
const sendViaLiteLLM = vi.fn(async () => ({
    text: 'litellm',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    model: 'lite',
    durationMs: 0,
}));
const sendViaLiteLLMConversation = vi.fn(async () => ({
    text: 'litellm-conv',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    model: 'lite',
    durationMs: 0,
}));

// Pass-through retry wrapper — we test retry semantics elsewhere.
vi.mock('../../../src/agents/ai-adapter-resilience', () => ({
    withNetworkRetry: async <T>(_model: string, fn: () => Promise<T>) => fn(),
}));

vi.mock('../../../src/agents/ai-adapter/claude-api', () => ({
    sendClaudePrompt,
    sendClaudeConversation,
}));
vi.mock('../../../src/agents/ai-adapter/claude-cli', () => ({
    sendClaudeCliPrompt,
}));
vi.mock('../../../src/agents/ai-adapter/openai', () => ({ sendOpenAiPrompt }));
vi.mock('../../../src/agents/ai-adapter/openrouter', () => ({ sendOpenRouterPrompt }));
vi.mock('../../../src/agents/ai-adapter/ollama', () => ({
    sendOllamaPrompt,
    sendOllamaConversation,
}));
vi.mock('../../../src/agents/ai-adapter/gemini', () => ({ sendGeminiPrompt }));

// LITELLM_PROXY_URL is read at module load — we override per-suite by
// re-importing the module after toggling the env var.
vi.mock('../../../src/agents/ai-adapter/litellm', () => {
    // The real module reads process.env at import time. For tests we expose
    // a setter via a mutable object on module scope.
    return {
        get LITELLM_PROXY_URL() {
            return process.env['LITELLM_PROXY_URL'] ?? null;
        },
        sendViaLiteLLM,
        sendViaLiteLLMConversation,
    };
});

// ── Tests ─────────────────────────────────────────────

describe('dispatcher — sendPrompt provider switch', () => {
    beforeEach(() => {
        delete process.env['LITELLM_PROXY_URL'];
        vi.clearAllMocks();
    });

    it('routes claude/<model> to sendClaudePrompt', async () => {
        const { sendPrompt } = await import('../../../src/agents/ai-adapter/dispatcher');
        await sendPrompt('claude/claude-sonnet-4-20250514', 'sys', 'hi');
        expect(sendClaudePrompt).toHaveBeenCalledTimes(1);
        expect(sendOpenAiPrompt).not.toHaveBeenCalled();
    });

    it('routes claude-cli/<model> to sendClaudeCliPrompt (not the API)', async () => {
        const { sendPrompt } = await import('../../../src/agents/ai-adapter/dispatcher');
        await sendPrompt('claude-cli/sonnet', 'sys', 'hi');
        expect(sendClaudeCliPrompt).toHaveBeenCalledTimes(1);
        expect(sendClaudePrompt).not.toHaveBeenCalled();
    });

    it('routes openrouter/<model> to sendOpenRouterPrompt', async () => {
        const { sendPrompt } = await import('../../../src/agents/ai-adapter/dispatcher');
        await sendPrompt('openrouter/anthropic/claude-3', 'sys', 'hi');
        expect(sendOpenRouterPrompt).toHaveBeenCalledTimes(1);
    });

    it('routes ollama/<model> to sendOllamaPrompt', async () => {
        const { sendPrompt } = await import('../../../src/agents/ai-adapter/dispatcher');
        await sendPrompt('ollama/llama3.2', 'sys', 'hi');
        expect(sendOllamaPrompt).toHaveBeenCalledTimes(1);
    });

    it('routes openai/<model> to sendOpenAiPrompt', async () => {
        const { sendPrompt } = await import('../../../src/agents/ai-adapter/dispatcher');
        await sendPrompt('openai/gpt-4o', 'sys', 'hi');
        expect(sendOpenAiPrompt).toHaveBeenCalledTimes(1);
    });

    it('routes gemini/<model> to sendGeminiPrompt', async () => {
        const { sendPrompt } = await import('../../../src/agents/ai-adapter/dispatcher');
        await sendPrompt('gemini/gemini-1.5-pro', 'sys', 'hi');
        expect(sendGeminiPrompt).toHaveBeenCalledTimes(1);
    });

    it('sets durationMs to a non-negative number on the returned response', async () => {
        const { sendPrompt } = await import('../../../src/agents/ai-adapter/dispatcher');
        const result = await sendPrompt('claude/x', 'sys', 'hi');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('throws when the provider prefix is unsupported', async () => {
        const { sendPrompt } = await import('../../../src/agents/ai-adapter/dispatcher');
        await expect(
            sendPrompt('mystery/some-model', 'sys', 'hi')
        ).rejects.toThrow('Unsupported AI provider');
    });
});

describe('dispatcher — LITELLM_PROXY_URL opt-in', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        delete process.env['LITELLM_PROXY_URL'];
    });

    it('reroutes sendPrompt through LiteLLM when LITELLM_PROXY_URL is set', async () => {
        process.env['LITELLM_PROXY_URL'] = 'http://localhost:4000';
        const { sendPrompt } = await import('../../../src/agents/ai-adapter/dispatcher');

        await sendPrompt('claude/claude-sonnet-4-20250514', 'sys', 'hi');
        expect(sendViaLiteLLM).toHaveBeenCalledTimes(1);
        // The direct Claude provider must NOT be reached.
        expect(sendClaudePrompt).not.toHaveBeenCalled();
    });

    it('reroutes sendConversation through LiteLLM when the env var is set', async () => {
        process.env['LITELLM_PROXY_URL'] = 'http://localhost:4000';
        const { sendConversation } = await import('../../../src/agents/ai-adapter/dispatcher');

        await sendConversation('claude/x', 'sys', [
            { role: 'user', content: 'hi' },
        ]);
        expect(sendViaLiteLLMConversation).toHaveBeenCalledTimes(1);
        expect(sendClaudeConversation).not.toHaveBeenCalled();
    });
});

describe('dispatcher — sendConversation flattening', () => {
    beforeEach(() => {
        delete process.env['LITELLM_PROXY_URL'];
        vi.clearAllMocks();
    });

    it('uses sendClaudeConversation for claude/ (native multi-turn)', async () => {
        const { sendConversation } = await import('../../../src/agents/ai-adapter/dispatcher');
        await sendConversation('claude/x', 'sys', [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ]);
        expect(sendClaudeConversation).toHaveBeenCalledTimes(1);
        expect(sendClaudePrompt).not.toHaveBeenCalled();
    });

    it('uses sendOllamaConversation for ollama/ (native multi-turn)', async () => {
        const { sendConversation } = await import('../../../src/agents/ai-adapter/dispatcher');
        await sendConversation('ollama/llama3.2', 'sys', [
            { role: 'user', content: 'hi' },
        ]);
        expect(sendOllamaConversation).toHaveBeenCalledTimes(1);
        expect(sendOllamaPrompt).not.toHaveBeenCalled();
    });

    it('flattens conversation to a single prompt for openai (no native chat adapter)', async () => {
        const { sendConversation } = await import('../../../src/agents/ai-adapter/dispatcher');
        await sendConversation('openai/gpt-4o', 'sys', [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hey' },
            { role: 'user', content: 'again' },
        ]);

        // sendOpenAiPrompt gets called with a single fused prompt containing
        // the tagged roles. Each role tag must appear in the flattened text.
        expect(sendOpenAiPrompt).toHaveBeenCalledTimes(1);
        const fusedUserPrompt = sendOpenAiPrompt.mock.calls[0][2] as string;
        expect(fusedUserPrompt).toContain('[user]: hi');
        expect(fusedUserPrompt).toContain('[assistant]: hey');
        expect(fusedUserPrompt).toContain('[user]: again');
    });

    it('flattens conversation for claude-cli too', async () => {
        const { sendConversation } = await import('../../../src/agents/ai-adapter/dispatcher');
        await sendConversation('claude-cli/sonnet', 'sys', [
            { role: 'user', content: 'q1' },
        ]);
        expect(sendClaudeCliPrompt).toHaveBeenCalledTimes(1);
    });

    it('throws on an unsupported provider inside sendConversation', async () => {
        const { sendConversation } = await import('../../../src/agents/ai-adapter/dispatcher');
        await expect(
            sendConversation('unknown/xx', 'sys', [{ role: 'user', content: 'hi' }])
        ).rejects.toThrow('Unsupported AI provider');
    });
});
