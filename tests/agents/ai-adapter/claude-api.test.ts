/**
 * Direct unit tests for the Claude (Anthropic API) provider module.
 *
 * Priorities:
 *   - No-key fallback path — delegates to sendClaudeCliPrompt verbatim.
 *   - Streaming SSE parsing — handles content_block_delta, message_start
 *     (input_tokens) and message_delta (output_tokens).
 *   - Conversation flattening when falling back to the CLI.
 *
 * We mock `https`, `child_process`, and the claude-cli binary resolver so
 * no real network or process is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// The claude-api module falls back to claude-cli when no API key is set,
// which will in turn resolve the CLI binary path. Point that resolver at a
// path that exists in every OS — `/bin/sh` was Unix-only and broke on
// Windows. `process.execPath` is the running Node binary, present on every
// platform, never executed by these tests (we mock `child_process.spawn`).
process.env['KAGEOPS_CLAUDE_CLI_PATH'] = process.execPath;

vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

vi.mock('https', () => ({
    request: vi.fn(),
}));

vi.mock('http', () => ({
    request: vi.fn(),
}));

vi.mock('../../../src/main/provider-key-registry', () => ({
    resolveDefaultKey: vi.fn(async () => null),
}));

vi.mock('../../../src/main/secret-store', () => ({
    getApiKey: vi.fn(async (provider: string) => {
        if (provider === 'claude') return process.env['ANTHROPIC_API_KEY'] ?? null;
        return null;
    }),
}));

import * as childProcess from 'child_process';
import * as https from 'https';
import {
    sendClaudeConversation,
    sendClaudePrompt,
} from '../../../src/agents/ai-adapter/claude-api';
import { _resetClaudeCliPathCacheForTests } from '../../../src/agents/ai-adapter/claude-cli';
import type { ProviderConfig } from '../../../src/agents/ai-adapter/types';

const mockSpawn = vi.mocked(childProcess.spawn);
const mockHttpsRequest = vi.mocked(https.request);

// ── HTTPS mock helpers ────────────────────────────────

interface MockBody {
    readonly statusCode?: number;
    readonly body: string;
}

function mockHttpsOnce(options: MockBody) {
    const res = new EventEmitter() as NodeJS.EventEmitter & { statusCode: number };
    res.statusCode = options.statusCode ?? 200;

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
            res.emit('data', options.body);
            res.emit('end');
        });
    });

    mockHttpsRequest.mockImplementation((_opts: unknown, callback: unknown) => {
        (callback as (r: unknown) => void)(res);
        return req as unknown as ReturnType<typeof https.request>;
    });

    return { req, res };
}

function mockHttpsStreamingOnce(sseChunks: readonly string[]) {
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
            for (const chunk of sseChunks) {
                res.emit('data', chunk);
            }
            res.emit('end');
        });
    });

    mockHttpsRequest.mockImplementation((_opts: unknown, callback: unknown) => {
        (callback as (r: unknown) => void)(res);
        return req as unknown as ReturnType<typeof https.request>;
    });

    return { req, res };
}

function makeMockProcess(stdout: string, exitCode = 0) {
    const proc = new EventEmitter() as NodeJS.EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };

    setImmediate(() => {
        proc.stdout.emit('data', stdout);
        proc.emit('close', exitCode);
    });
    return proc;
}

const CLAUDE_CFG: ProviderConfig = {
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
};

// ── Tests ─────────────────────────────────────────────

describe('sendClaudePrompt — direct unit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetClaudeCliPathCacheForTests();
    });

    it('hits api.anthropic.com and parses the usage block', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        mockHttpsOnce({
            body: JSON.stringify({
                content: [{ type: 'text', text: 'hello' }],
                usage: { input_tokens: 42, output_tokens: 7 },
            }),
        });

        const result = await sendClaudePrompt(CLAUDE_CFG, 'sys', 'user', {});

        expect(mockHttpsRequest).toHaveBeenCalled();
        const opts = mockHttpsRequest.mock.calls[0][0] as { hostname: string; path: string };
        expect(opts.hostname).toBe('api.anthropic.com');
        expect(opts.path).toBe('/v1/messages');
        expect(result.text).toBe('hello');
        expect(result.tokensIn).toBe(42);
        expect(result.tokensOut).toBe(7);
        expect(result.model).toBe(CLAUDE_CFG.model);

        delete process.env.ANTHROPIC_API_KEY;
    });

    it('falls back to the Claude CLI when no API key is present', async () => {
        delete process.env.ANTHROPIC_API_KEY;
        mockSpawn.mockReturnValue(
            makeMockProcess('cli-output') as unknown as ReturnType<typeof childProcess.spawn>
        );

        const result = await sendClaudePrompt(CLAUDE_CFG, 'sys', 'user', {});

        // CLI path was invoked — HTTPS must NOT have been touched.
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect(mockHttpsRequest).not.toHaveBeenCalled();
        expect(result.text).toBe('cli-output');
        // The fallback path drops the full Anthropic model ID and lets the
        // CLI pick its default, so the reported model is just "claude-cli".
        expect(result.model).toBe('claude-cli');
    });

    it('handles a streaming response with content_block_delta + message_start + message_delta', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';

        const chunks = [
            // message_start carries input_tokens
            'data: {"type":"message_start","message":{"usage":{"input_tokens":123}}}\n\n',
            // two content deltas — both should stream
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
            // message_delta carries output_tokens
            'data: {"type":"message_delta","usage":{"output_tokens":45}}\n\n',
            // terminal marker — should be ignored gracefully
            'data: [DONE]\n\n',
        ];
        mockHttpsStreamingOnce(chunks);

        const streamed: string[] = [];
        const result = await sendClaudePrompt(
            CLAUDE_CFG,
            'sys',
            'user',
            { onStream: (c) => streamed.push(c) }
        );

        expect(streamed).toEqual(['Hel', 'lo']);
        expect(result.text).toBe('Hello');
        expect(result.tokensIn).toBe(123);
        expect(result.tokensOut).toBe(45);
        expect(result.model).toBe(CLAUDE_CFG.model);

        delete process.env.ANTHROPIC_API_KEY;
    });

    it('skips malformed JSON events during streaming without crashing', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';

        const chunks = [
            'data: not-valid-json\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
        ];
        mockHttpsStreamingOnce(chunks);

        const result = await sendClaudePrompt(CLAUDE_CFG, 'sys', 'user', { onStream: () => { /* ignore */ } });

        expect(result.text).toBe('OK');

        delete process.env.ANTHROPIC_API_KEY;
    });
});

describe('sendClaudeConversation — direct unit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetClaudeCliPathCacheForTests();
    });

    it('posts messages with non-system roles preserved', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        const { req } = mockHttpsOnce({
            body: JSON.stringify({
                content: [{ type: 'text', text: 'ok' }],
                usage: { input_tokens: 10, output_tokens: 5 },
            }),
        });

        await sendClaudeConversation(
            CLAUDE_CFG,
            'sys',
            [
                { role: 'user', content: 'q' },
                { role: 'assistant', content: 'a' },
            ],
            {}
        );

        // The body was written to the request object in full — inspect it.
        const writtenBody = (req.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        const parsed = JSON.parse(writtenBody) as { messages: Array<{ role: string; content: string }> };
        expect(parsed.messages).toEqual([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a' },
        ]);

        delete process.env.ANTHROPIC_API_KEY;
    });

    it('falls back to CLI (flattened single-shot) when no API key is set', async () => {
        delete process.env.ANTHROPIC_API_KEY;
        const mockProc = makeMockProcess('flattened-cli-output');
        mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof childProcess.spawn>);

        const result = await sendClaudeConversation(
            CLAUDE_CFG,
            'sys',
            [
                { role: 'user', content: 'first' },
                { role: 'assistant', content: 'then' },
            ],
            {}
        );

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect(mockHttpsRequest).not.toHaveBeenCalled();
        expect(result.text).toBe('flattened-cli-output');

        // F-381: prompt is on stdin now, not argv. Both turns should appear
        // in the stdin payload tagged with their roles.
        const stdinCalls = mockProc.stdin.end.mock.calls as unknown[][];
        expect(stdinCalls.length).toBeGreaterThan(0);
        const fused = (stdinCalls[0][0] as string) ?? '';
        expect(fused).toContain('[user]: first');
        expect(fused).toContain('[assistant]: then');
    });

    it('rewrites the "system" role in message history to "user" (Claude API quirk)', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        const { req } = mockHttpsOnce({
            body: JSON.stringify({
                content: [{ type: 'text', text: 'ok' }],
                usage: { input_tokens: 1, output_tokens: 1 },
            }),
        });

        await sendClaudeConversation(
            CLAUDE_CFG,
            'sys',
            [{ role: 'system', content: 'inline system note' }],
            {}
        );

        const writtenBody = (req.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        const parsed = JSON.parse(writtenBody) as { messages: Array<{ role: string }> };
        // system role gets rewritten to "user" because Claude's messages array
        // rejects the role "system".
        expect(parsed.messages[0].role).toBe('user');

        delete process.env.ANTHROPIC_API_KEY;
    });
});
