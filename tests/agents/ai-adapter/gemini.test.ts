/**
 * Direct unit tests for the Gemini provider module.
 *
 * Priorities:
 *   - API key enforcement (throws without GOOGLE_API_KEY)
 *   - SSE JSON buffering — incomplete JSON must be re-buffered and parsed
 *     when the next chunk arrives
 *   - usageMetadata extraction (promptTokenCount / candidatesTokenCount)
 *   - Streaming text accumulation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('https', () => ({ request: vi.fn() }));
vi.mock('http', () => ({ request: vi.fn() }));

vi.mock('../../../src/main/provider-key-registry', () => ({
    resolveDefaultKey: vi.fn(async () => null),
}));

vi.mock('../../../src/main/secret-store', () => ({
    getApiKey: vi.fn(async (provider: string) => {
        if (provider === 'gemini') return process.env['GOOGLE_API_KEY'] ?? null;
        return null;
    }),
}));

import * as https from 'https';
import { sendGeminiPrompt } from '../../../src/agents/ai-adapter/gemini';
import type { ProviderConfig } from '../../../src/agents/ai-adapter/types';

const mockHttps = vi.mocked(https.request);

// ── Helpers ───────────────────────────────────────────

function makeJsonResponse(body: string, statusCode = 200) {
    const res = new EventEmitter() as NodeJS.EventEmitter & { statusCode: number };
    res.statusCode = statusCode;

    const req = new EventEmitter() as NodeJS.EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        setTimeout: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
    };
    req.write = vi.fn();
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();
    req.end = vi.fn().mockImplementation(() => {
        setImmediate(() => {
            res.emit('data', body);
            res.emit('end');
        });
    });

    return { req, res };
}

function makeStreamingResponse(chunks: readonly string[]) {
    const res = new EventEmitter() as NodeJS.EventEmitter & {
        statusCode: number;
        setEncoding: ReturnType<typeof vi.fn>;
    };
    res.statusCode = 200;
    res.setEncoding = vi.fn();

    const req = new EventEmitter() as NodeJS.EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        setTimeout: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
    };
    req.write = vi.fn();
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();
    req.end = vi.fn().mockImplementation(() => {
        setImmediate(() => {
            for (const c of chunks) res.emit('data', c);
            res.emit('end');
        });
    });

    return { req, res };
}

function setupHttps(response: { req: unknown; res: EventEmitter }) {
    mockHttps.mockImplementation((_opts: unknown, cb: unknown) => {
        (cb as (r: unknown) => void)(response.res);
        return response.req as ReturnType<typeof https.request>;
    });
}

const GEMINI_CFG: ProviderConfig = {
    provider: 'gemini',
    model: 'gemini-1.5-pro',
};

// ── Tests ─────────────────────────────────────────────

describe('sendGeminiPrompt — API key enforcement', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env['GOOGLE_API_KEY'];
    });

    afterEach(() => {
        delete process.env['GOOGLE_API_KEY'];
    });

    it('throws a descriptive error when GOOGLE_API_KEY is missing', async () => {
        await expect(
            sendGeminiPrompt(GEMINI_CFG, 'sys', 'user', {})
        ).rejects.toThrow(/GOOGLE_API_KEY is required/);
    });
});

describe('sendGeminiPrompt — non-streaming', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env['GOOGLE_API_KEY'] = 'test-gemini-key';
    });

    afterEach(() => {
        delete process.env['GOOGLE_API_KEY'];
    });

    it('parses candidates[0].content.parts[0].text and usageMetadata', async () => {
        setupHttps(makeJsonResponse(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Gemini response' }] } }],
            usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 45 },
        })));

        const result = await sendGeminiPrompt(GEMINI_CFG, 'sys', 'user', {});

        expect(result.text).toBe('Gemini response');
        expect(result.tokensIn).toBe(123);
        expect(result.tokensOut).toBe(45);
        expect(result.model).toBe(GEMINI_CFG.model);

        const opts = mockHttps.mock.calls[0][0] as { hostname: string; path: string };
        expect(opts.hostname).toBe('generativelanguage.googleapis.com');
        expect(opts.path).toContain(`/v1beta/models/${GEMINI_CFG.model}:generateContent`);
        // The API key is passed as a query parameter.
        expect(opts.path).toContain('key=test-gemini-key');
    });

    it('defaults tokens to 0 when usageMetadata is absent', async () => {
        setupHttps(makeJsonResponse(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'no usage' }] } }],
        })));

        const result = await sendGeminiPrompt(GEMINI_CFG, 'sys', 'user', {});
        expect(result.tokensIn).toBe(0);
        expect(result.tokensOut).toBe(0);
    });
});

describe('sendGeminiPrompt — streaming with JSON buffering', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env['GOOGLE_API_KEY'] = 'test-key';
    });

    afterEach(() => {
        delete process.env['GOOGLE_API_KEY'];
    });

    it('streams complete JSON lines in a single chunk', async () => {
        const event1 = JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Hel' }] } }],
        });
        const event2 = JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'lo' }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        });
        const chunks = [
            `data: ${event1}\n\n`,
            `data: ${event2}\n\n`,
        ];
        setupHttps(makeStreamingResponse(chunks));

        const streamed: string[] = [];
        const result = await sendGeminiPrompt(
            GEMINI_CFG,
            'sys',
            'user',
            { onStream: (c) => streamed.push(c) }
        );

        expect(streamed).toEqual(['Hel', 'lo']);
        expect(result.text).toBe('Hello');
        expect(result.tokensIn).toBe(10);
        expect(result.tokensOut).toBe(2);

        // streaming endpoint differs from the non-streaming one
        const opts = mockHttps.mock.calls[0][0] as { path: string };
        expect(opts.path).toContain(':streamGenerateContent');
        expect(opts.path).toContain('alt=sse');
    });

    it('re-buffers incomplete JSON split across two chunks and parses it on completion', async () => {
        // First chunk has an incomplete JSON object missing its closing brace
        // and newline. The handler must re-buffer and merge with the next chunk.
        const payload = JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'complete' }] } }],
        });
        // Find a safe split point roughly in the middle of the payload.
        const halfway = Math.floor(payload.length / 2);
        const chunk1 = `data: ${payload.slice(0, halfway)}`;
        const chunk2 = `${payload.slice(halfway)}\n\n`;

        setupHttps(makeStreamingResponse([chunk1, chunk2]));

        const streamed: string[] = [];
        const result = await sendGeminiPrompt(
            GEMINI_CFG,
            'sys',
            'user',
            { onStream: (c) => streamed.push(c) }
        );

        // The buffered payload must eventually resolve to exactly one streamed
        // chunk equal to the text payload.
        expect(streamed).toEqual(['complete']);
        expect(result.text).toBe('complete');
    });

    it('ignores [DONE] and comment-prefixed lines', async () => {
        const payload = JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'final' }] } }],
        });
        const chunks = [
            ': heartbeat comment\n',
            '\n',
            `data: ${payload}\n\n`,
            'data: [DONE]\n\n',
        ];
        setupHttps(makeStreamingResponse(chunks));

        const result = await sendGeminiPrompt(
            GEMINI_CFG,
            'sys',
            'user',
            { onStream: () => { /* ignore */ } }
        );
        expect(result.text).toBe('final');
    });
});
