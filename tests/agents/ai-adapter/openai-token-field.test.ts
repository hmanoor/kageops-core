/**
 * Unit test for the token-field selection logic in src/agents/ai-adapter/openai.ts.
 *
 * Bug context: GPT-5 family / o1 / o3 reasoning models reject `max_tokens`
 * with HTTP 400 ("Unsupported parameter") and require `max_completion_tokens`.
 * Older GPT-4o / GPT-4 / GPT-3.5 still accept `max_tokens`. Surfaced when
 * the OpenAI UI design provider routed a Pixel task to gpt-5.4 and the
 * platform rejected the request mid-run.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/agents/ai-adapter/api-keys', () => ({
    resolveProviderApiKey: vi.fn(async () => 'sk-test'),
}));

vi.mock('../../../src/agents/ai-adapter/http', () => ({
    httpRequest: vi.fn(async () => JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 5, completion_tokens: 7 },
    })),
    httpStreamRequest: vi.fn(async () => undefined),
}));

vi.mock('../../../src/agents/ai-adapter/cost', () => ({
    calculateCost: vi.fn(() => 0),
}));

import { sendOpenAiPrompt } from '../../../src/agents/ai-adapter/openai';
import { httpRequest } from '../../../src/agents/ai-adapter/http';

const httpRequestMock = httpRequest as unknown as ReturnType<typeof vi.fn>;

function lastBodyAsJson(): Record<string, unknown> {
    const calls = httpRequestMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    const body = lastCall[1] as string;
    return JSON.parse(body) as Record<string, unknown>;
}

describe('sendOpenAiPrompt — token cap field selection', () => {
    beforeEach(() => {
        httpRequestMock.mockClear();
    });

    it('uses max_completion_tokens for gpt-5 family', async () => {
        await sendOpenAiPrompt(
            { model: 'gpt-5.4', apiKey: 'sk-test' },
            'sys',
            'user',
            { maxTokens: 1024 }
        );
        const body = lastBodyAsJson();
        expect(body['max_completion_tokens']).toBe(1024);
        expect(body['max_tokens']).toBeUndefined();
    });

    it('uses max_completion_tokens for o1 reasoning models', async () => {
        await sendOpenAiPrompt(
            { model: 'o1', apiKey: 'sk-test' },
            'sys',
            'user',
            { maxTokens: 2048 }
        );
        const body = lastBodyAsJson();
        expect(body['max_completion_tokens']).toBe(2048);
        expect(body['max_tokens']).toBeUndefined();
    });

    it('uses max_completion_tokens for o3 / o4', async () => {
        await sendOpenAiPrompt(
            { model: 'o3-mini', apiKey: 'sk-test' },
            'sys',
            'user',
            { maxTokens: 512 }
        );
        const body = lastBodyAsJson();
        expect(body['max_completion_tokens']).toBe(512);
    });

    it('uses max_tokens for legacy gpt-4o', async () => {
        await sendOpenAiPrompt(
            { model: 'gpt-4o', apiKey: 'sk-test' },
            'sys',
            'user',
            { maxTokens: 4096 }
        );
        const body = lastBodyAsJson();
        expect(body['max_tokens']).toBe(4096);
        expect(body['max_completion_tokens']).toBeUndefined();
    });

    it('uses max_tokens for gpt-4-turbo', async () => {
        await sendOpenAiPrompt(
            { model: 'gpt-4-turbo', apiKey: 'sk-test' },
            'sys',
            'user',
            { maxTokens: 2000 }
        );
        const body = lastBodyAsJson();
        expect(body['max_tokens']).toBe(2000);
    });

    it('strips the openai/ prefix when detecting model family', async () => {
        await sendOpenAiPrompt(
            { model: 'openai/gpt-5.4', apiKey: 'sk-test' },
            'sys',
            'user',
            { maxTokens: 256 }
        );
        const body = lastBodyAsJson();
        expect(body['max_completion_tokens']).toBe(256);
    });

    it('defaults the token cap to 4096 when maxTokens is omitted', async () => {
        await sendOpenAiPrompt(
            { model: 'gpt-5.4', apiKey: 'sk-test' },
            'sys',
            'user',
            {}
        );
        const body = lastBodyAsJson();
        expect(body['max_completion_tokens']).toBe(4096);
    });
});
