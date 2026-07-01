/**
 * Direct unit tests for the LiteLLM proxy routing module.
 *
 * Priorities:
 *   - sendViaLiteLLM posts to the proxy URL and parses OpenAI-style responses
 *   - Bearer token uses LITELLM_MASTER_KEY (default "kageops-dev-key")
 *   - Conversation variant prepends the system message
 *   - Streaming mode reuses sendOpenAiStyleStreaming (OpenAI-compatible SSE)
 *
 * NOTE: LITELLM_PROXY_URL is captured at module import time. The env var is
 * set before the dynamic `await import(...)` inside each test so the module
 * sees the intended value.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('http', () => ({ request: vi.fn() }));
vi.mock('https', () => ({ request: vi.fn() }));

import * as http from 'http';
import * as https from 'https';

const mockHttp = vi.mocked(http.request);
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

function setupHttp(response: { req: unknown; res: EventEmitter }) {
    mockHttp.mockImplementation((_opts: unknown, cb: unknown) => {
        (cb as (r: unknown) => void)(response.res);
        return response.req as ReturnType<typeof http.request>;
    });
}

// ── Tests ─────────────────────────────────────────────

describe('LiteLLM module constants', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        delete process.env['LITELLM_PROXY_URL'];
        delete process.env['LITELLM_MASTER_KEY'];
    });

    it('reads LITELLM_PROXY_URL from env at import time', async () => {
        process.env['LITELLM_PROXY_URL'] = 'http://localhost:4000';
        const mod = await import('../../../src/agents/ai-adapter/litellm');
        expect(mod.LITELLM_PROXY_URL).toBe('http://localhost:4000');
    });

    it('reads LITELLM_MASTER_KEY from env', async () => {
        process.env['LITELLM_MASTER_KEY'] = 'custom-master-key';
        const mod = await import('../../../src/agents/ai-adapter/litellm');
        expect(mod.LITELLM_MASTER_KEY).toBe('custom-master-key');
    });

    it('defaults LITELLM_MASTER_KEY to kageops-dev-key when env is not set', async () => {
        delete process.env['LITELLM_MASTER_KEY'];
        const mod = await import('../../../src/agents/ai-adapter/litellm');
        expect(mod.LITELLM_MASTER_KEY).toBe('kageops-dev-key');
    });

    it('LITELLM_PROXY_URL is null when the env var is absent', async () => {
        delete process.env['LITELLM_PROXY_URL'];
        const mod = await import('../../../src/agents/ai-adapter/litellm');
        expect(mod.LITELLM_PROXY_URL).toBeNull();
    });
});

describe('sendViaLiteLLM — single-shot prompt', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        process.env['LITELLM_PROXY_URL'] = 'http://localhost:4000';
        process.env['LITELLM_MASTER_KEY'] = 'test-master-key';
    });

    afterEach(() => {
        delete process.env['LITELLM_PROXY_URL'];
        delete process.env['LITELLM_MASTER_KEY'];
    });

    it('posts to the /chat/completions proxy path on the configured host/port', async () => {
        const { sendViaLiteLLM } = await import('../../../src/agents/ai-adapter/litellm');
        setupHttp(makeJsonResponse(JSON.stringify({
            choices: [{ message: { content: 'proxy reply' } }],
            usage: { prompt_tokens: 40, completion_tokens: 20 },
        })));

        await sendViaLiteLLM(
            'claude/claude-sonnet-4-20250514',
            'sys',
            'user',
            {}
        );

        expect(mockHttp).toHaveBeenCalledTimes(1);
        const opts = mockHttp.mock.calls[0][0] as {
            hostname: string;
            port: number;
            path: string;
            headers: Record<string, string>;
        };
        expect(opts.hostname).toBe('localhost');
        expect(opts.port).toBe(4000);
        expect(opts.path).toBe('/chat/completions');
        expect(opts.headers['Authorization']).toBe('Bearer test-master-key');
    });

    it('passes the full provider/model string through to LiteLLM unchanged', async () => {
        const { sendViaLiteLLM } = await import('../../../src/agents/ai-adapter/litellm');
        const response = makeJsonResponse(JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
        setupHttp(response);

        const model = 'openrouter/anthropic/claude-3';
        await sendViaLiteLLM(model, 'sys', 'user', {});

        const body = (response.req as unknown as {
            write: ReturnType<typeof vi.fn>;
        }).write.mock.calls[0][0] as string;
        const parsed = JSON.parse(body) as { model: string };
        expect(parsed.model).toBe(model);
    });

    it('parses usage tokens and reports them on the response', async () => {
        const { sendViaLiteLLM } = await import('../../../src/agents/ai-adapter/litellm');
        setupHttp(makeJsonResponse(JSON.stringify({
            choices: [{ message: { content: 'x' } }],
            usage: { prompt_tokens: 77, completion_tokens: 33 },
        })));

        const result = await sendViaLiteLLM('openai/gpt-4o', 'sys', 'user', {});

        expect(result.tokensIn).toBe(77);
        expect(result.tokensOut).toBe(33);
        expect(result.model).toBe('openai/gpt-4o');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('handles missing usage gracefully (0 tokens)', async () => {
        const { sendViaLiteLLM } = await import('../../../src/agents/ai-adapter/litellm');
        setupHttp(makeJsonResponse(JSON.stringify({
            choices: [{ message: { content: 'reply' } }],
        })));

        const result = await sendViaLiteLLM('claude/x', 'sys', 'user', {});
        expect(result.tokensIn).toBe(0);
        expect(result.tokensOut).toBe(0);
        expect(result.text).toBe('reply');
    });

    it('adds stream: true when onStream is supplied and streams OpenAI-style SSE', async () => {
        // sendViaLiteLLM forwards the parsed proxy URL's protocol + port to
        // sendOpenAiStyleStreaming so that http:// proxies (the default for
        // local LiteLLM at http://localhost:4000) aren't silently upgraded
        // to https. This test pins that contract by mocking http.request
        // and asserting https.request is never touched.
        const { sendViaLiteLLM } = await import('../../../src/agents/ai-adapter/litellm');
        const chunks = [
            'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
            'data: [DONE]\n\n',
        ];
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

        let capturedOpts: { port?: number } | undefined;
        mockHttp.mockImplementation((opts: unknown, cb: unknown) => {
            capturedOpts = opts as { port?: number };
            (cb as (r: unknown) => void)(res);
            return req as unknown as ReturnType<typeof http.request>;
        });

        const streamed: string[] = [];
        const result = await sendViaLiteLLM(
            'claude/x',
            'sys',
            'user',
            { onStream: (c) => streamed.push(c) }
        );

        const body = (req.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(body).toContain('"stream":true');
        // https.request must NOT be called when proxy URL is http://
        expect(mockHttps).not.toHaveBeenCalled();
        expect(capturedOpts?.port).toBe(4000);

        expect(streamed).toEqual(['a', 'b']);
        expect(result.text).toBe('ab');
    });
});

describe('sendViaLiteLLMConversation', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        process.env['LITELLM_PROXY_URL'] = 'http://localhost:4000';
        process.env['LITELLM_MASTER_KEY'] = 'test-key';
    });

    afterEach(() => {
        delete process.env['LITELLM_PROXY_URL'];
        delete process.env['LITELLM_MASTER_KEY'];
    });

    it('prepends the system message to the conversation history', async () => {
        const { sendViaLiteLLMConversation } = await import('../../../src/agents/ai-adapter/litellm');
        const response = makeJsonResponse(JSON.stringify({
            choices: [{ message: { content: 'ack' } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
        }));
        setupHttp(response);

        await sendViaLiteLLMConversation(
            'claude/x',
            'SYS',
            [
                { role: 'user', content: 'Q1' },
                { role: 'assistant', content: 'A1' },
            ],
            {}
        );

        const body = (response.req as unknown as {
            write: ReturnType<typeof vi.fn>;
        }).write.mock.calls[0][0] as string;
        const parsed = JSON.parse(body) as {
            messages: Array<{ role: string; content: string }>;
        };
        expect(parsed.messages[0]).toEqual({ role: 'system', content: 'SYS' });
        expect(parsed.messages).toHaveLength(3);
    });
});
