/**
 * Direct unit tests for the Ollama provider module.
 *
 * Priorities:
 *   - Cloud vs local detection via OLLAMA_API_KEY and OLLAMA_HOST
 *   - Bearer auth header is only added in cloud mode
 *   - NDJSON streaming parses response chunks
 *   - <think>…</think> blocks are stripped from reasoning-model output
 *   - Conversation mode posts to /api/chat with the system turn prepended
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('http', () => ({ request: vi.fn() }));
vi.mock('https', () => ({ request: vi.fn() }));

vi.mock('../../../src/main/provider-key-registry', () => ({
    resolveDefaultKey: vi.fn(async () => null),
}));

vi.mock('../../../src/main/secret-store', () => ({
    getApiKey: vi.fn(async (provider: string) => {
        if (provider === 'ollama') return process.env['OLLAMA_API_KEY'] ?? null;
        return null;
    }),
}));

import * as http from 'http';
import * as https from 'https';
import {
    sendOllamaConversation,
    sendOllamaPrompt,
} from '../../../src/agents/ai-adapter/ollama';
import type { ProviderConfig } from '../../../src/agents/ai-adapter/types';

const mockHttp = vi.mocked(http.request);
const mockHttps = vi.mocked(https.request);

// ── Mock helpers ──────────────────────────────────────

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

function setupHttp(response: { req: unknown; res: EventEmitter }) {
    mockHttp.mockImplementation((_opts: unknown, cb: unknown) => {
        (cb as (r: unknown) => void)(response.res);
        return response.req as ReturnType<typeof http.request>;
    });
}

function setupHttps(response: { req: unknown; res: EventEmitter }) {
    mockHttps.mockImplementation((_opts: unknown, cb: unknown) => {
        (cb as (r: unknown) => void)(response.res);
        return response.req as ReturnType<typeof https.request>;
    });
}

const OLLAMA_CFG: ProviderConfig = { provider: 'ollama', model: 'llama3.2' };

// ── Tests ─────────────────────────────────────────────

describe('sendOllamaPrompt — local vs cloud detection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env['OLLAMA_API_KEY'];
        delete process.env['OLLAMA_HOST'];
    });

    afterEach(() => {
        delete process.env['OLLAMA_API_KEY'];
        delete process.env['OLLAMA_HOST'];
    });

    it('uses local HTTP (localhost:11434) when no API key or custom host', async () => {
        setupHttp(makeJsonResponse(JSON.stringify({ response: 'hello' })));

        await sendOllamaPrompt(OLLAMA_CFG, 'sys', 'user', {});

        expect(mockHttp).toHaveBeenCalled();
        expect(mockHttps).not.toHaveBeenCalled();
        const opts = mockHttp.mock.calls[0][0] as {
            hostname: string;
            port: number;
            headers: Record<string, string>;
        };
        expect(opts.hostname).toBe('localhost');
        expect(opts.port).toBe(11434);
        // No Authorization header in local mode.
        expect(opts.headers['Authorization']).toBeUndefined();
    });

    it('switches to cloud HTTPS when OLLAMA_API_KEY is set (adds Bearer auth)', async () => {
        process.env['OLLAMA_API_KEY'] = 'cloud-key';
        setupHttps(makeJsonResponse(JSON.stringify({ response: 'cloud reply' })));

        await sendOllamaPrompt(OLLAMA_CFG, 'sys', 'user', {});

        expect(mockHttps).toHaveBeenCalled();
        expect(mockHttp).not.toHaveBeenCalled();
        const opts = mockHttps.mock.calls[0][0] as {
            hostname: string;
            headers: Record<string, string>;
        };
        expect(opts.hostname).toBe('ollama.com');
        expect(opts.headers['Authorization']).toBe('Bearer cloud-key');
    });

    it('switches to cloud when OLLAMA_HOST points at ollama.com (no API key required)', async () => {
        process.env['OLLAMA_HOST'] = 'https://ollama.com';
        setupHttps(makeJsonResponse(JSON.stringify({ response: 'cloud via host' })));

        await sendOllamaPrompt(OLLAMA_CFG, 'sys', 'user', {});

        expect(mockHttps).toHaveBeenCalled();
        const opts = mockHttps.mock.calls[0][0] as { hostname: string };
        expect(opts.hostname).toBe('ollama.com');
    });
});

describe('sendOllamaPrompt — response shaping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env['OLLAMA_API_KEY'];
        delete process.env['OLLAMA_HOST'];
    });

    it('strips <think>...</think> blocks from reasoning-model output', async () => {
        setupHttp(makeJsonResponse(JSON.stringify({
            response: '<think>internal reasoning</think>Final answer',
        })));

        const result = await sendOllamaPrompt(OLLAMA_CFG, 'sys', 'user', {});
        expect(result.text).toBe('Final answer');
    });

    it('reports costUsd of 0 (local inference)', async () => {
        setupHttp(makeJsonResponse(JSON.stringify({ response: 'free' })));

        const result = await sendOllamaPrompt(OLLAMA_CFG, 'sys', 'user', {});
        expect(result.costUsd).toBe(0);
    });

    it('estimates tokensIn / tokensOut (no usage metadata from Ollama)', async () => {
        setupHttp(makeJsonResponse(JSON.stringify({ response: 'some reply' })));

        const result = await sendOllamaPrompt(OLLAMA_CFG, 'sys prompt', 'user prompt', {});
        expect(result.tokensIn).toBeGreaterThan(0);
        expect(result.tokensOut).toBeGreaterThan(0);
    });
});

describe('sendOllamaPrompt — NDJSON streaming', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env['OLLAMA_API_KEY'];
        delete process.env['OLLAMA_HOST'];
    });

    it('forwards response tokens to onStream and accumulates the full text', async () => {
        // NDJSON: one JSON object per line
        const chunks = [
            '{"response":"Hel"}\n',
            '{"response":"lo "}\n',
            '{"response":"world"}\n',
            '{"done":true}\n',
        ];
        setupHttp(makeStreamingResponse(chunks));

        const streamed: string[] = [];
        const result = await sendOllamaPrompt(
            OLLAMA_CFG,
            'sys',
            'user',
            { onStream: (c) => streamed.push(c) }
        );

        expect(streamed).toEqual(['Hel', 'lo ', 'world']);
        expect(result.text).toBe('Hello world');
    });

    it('strips <think> blocks from accumulated streaming output', async () => {
        const chunks = [
            '{"response":"<think>reasoning</think>"}\n',
            '{"response":"answer"}\n',
        ];
        setupHttp(makeStreamingResponse(chunks));

        const result = await sendOllamaPrompt(
            OLLAMA_CFG,
            'sys',
            'user',
            { onStream: () => { /* ignore */ } }
        );
        expect(result.text).toBe('answer');
    });
});

describe('sendOllamaConversation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env['OLLAMA_API_KEY'];
        delete process.env['OLLAMA_HOST'];
    });

    it('posts to /api/chat with the system message prepended to the history', async () => {
        const response = makeJsonResponse(JSON.stringify({
            message: { content: 'assistant reply' },
        }));
        setupHttp(response);

        const result = await sendOllamaConversation(
            OLLAMA_CFG,
            'system-note',
            [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi' },
                { role: 'user', content: 'how are you?' },
            ],
            {}
        );

        const writtenBody = (response.req as unknown as {
            write: ReturnType<typeof vi.fn>;
        }).write.mock.calls[0][0] as string;
        const parsed = JSON.parse(writtenBody) as {
            messages: Array<{ role: string; content: string }>;
        };

        expect(parsed.messages[0]).toEqual({ role: 'system', content: 'system-note' });
        expect(parsed.messages[1]).toEqual({ role: 'user', content: 'hello' });
        expect(parsed.messages).toHaveLength(4);
        expect(result.text).toBe('assistant reply');

        const opts = mockHttp.mock.calls[0][0] as { path: string };
        expect(opts.path).toBe('/api/chat');
    });

    it('strips <think> blocks from the assistant reply', async () => {
        setupHttp(makeJsonResponse(JSON.stringify({
            message: { content: '<think>wait</think>done' },
        })));

        const result = await sendOllamaConversation(
            OLLAMA_CFG,
            'sys',
            [{ role: 'user', content: 'q' }],
            {}
        );
        expect(result.text).toBe('done');
    });
});
