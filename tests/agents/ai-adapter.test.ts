/**
 * AI Adapter behavioral tests
 *
 * Tests provider routing, API key enforcement, response shaping,
 * and the CLI fallback — all via sendPrompt().
 *
 * Network calls (https/http) and child_process.spawn are mocked so
 * no real AI provider is ever contacted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Point the claude-cli resolver at a path that exists on every OS — the
// previous `/bin/sh` worked on Unix CI but failed on Windows. The spawn
// mock intercepts regardless; we just need resolveClaudeCliBinary() to
// return non-null. `process.execPath` is the running Node binary, always
// present, never executed.
process.env['KAGEOPS_CLAUDE_CLI_PATH'] = process.execPath;
const CLAUDE_CLI_TEST_BIN = process.execPath;

// ── Module mocks ──────────────────────────────────────
// Must appear before any import of the module under test.

vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

vi.mock('https', () => ({
    request: vi.fn(),
}));

vi.mock('http', () => ({
    request: vi.fn(),
}));

// Prevent registry DB lookups from stalling in tests.
vi.mock('../../src/main/provider-key-registry', () => ({
    resolveDefaultKey: vi.fn(async () => null),
}));

// Prevent OS Keychain from leaking real stored keys into env-var-driven tests.
vi.mock('../../src/main/secret-store', () => ({
    getApiKey: vi.fn(async (provider: string) => {
        const envMap: Record<string, string> = {
            claude: 'ANTHROPIC_API_KEY',
            openrouter: 'OPENROUTER_API_KEY',
            openai: 'OPENAI_API_KEY',
            gemini: 'GOOGLE_API_KEY',
            ollama: 'OLLAMA_API_KEY',
            github: 'GITHUB_TOKEN',
        };
        const envVar = envMap[provider];
        return envVar !== undefined ? (process.env[envVar] ?? null) : null;
    }),
    setApiKey: vi.fn(),
    hasApiKey: vi.fn(async () => false),
    deleteApiKey: vi.fn(),
    getApiKeyStatus: vi.fn(async () => ({})),
}));

// ── Imports after mocks ───────────────────────────────

import * as childProcess from 'child_process';
import * as https from 'https';
import * as http from 'http';
import { sendPrompt } from '../../src/agents/ai-adapter';
import { EventEmitter } from 'events';

const mockSpawn = vi.mocked(childProcess.spawn);
const mockHttpsRequest = vi.mocked(https.request);
const mockHttpRequest = vi.mocked(http.request);

// ── HTTP mock helpers ─────────────────────────────────

interface MockResponseOptions {
    statusCode?: number;
    body: string;
}

/**
 * Creates a mock http.ClientRequest + IncomingMessage pair.
 * Calling req.end() triggers the response to be emitted.
 */
function makeMockHttpResponse({ statusCode = 200, body }: MockResponseOptions) {
    const res = new EventEmitter() as NodeJS.EventEmitter & { statusCode: number };
    res.statusCode = statusCode;

    const req = new EventEmitter() as NodeJS.EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
    };
    req.write = vi.fn();
    req.end = vi.fn().mockImplementation(() => {
        // Emit data and end on next tick so the promise can set up handlers first
        setImmediate(() => {
            res.emit('data', body);
            res.emit('end');
        });
    });

    return { req, res };
}

function setupHttpsMock(options: MockResponseOptions) {
    const { req, res } = makeMockHttpResponse(options);
    mockHttpsRequest.mockImplementation((_opts: unknown, callback: unknown) => {
        (callback as (r: unknown) => void)(res);
        return req as unknown as ReturnType<typeof https.request>;
    });
    return { req, res };
}

function setupHttpMock(options: MockResponseOptions) {
    const { req, res } = makeMockHttpResponse(options);
    mockHttpRequest.mockImplementation((_opts: unknown, callback: unknown) => {
        (callback as (r: unknown) => void)(res);
        return req as unknown as ReturnType<typeof http.request>;
    });
    return { req, res };
}

/**
 * Build a mock child process that emits stdout and exits cleanly.
 */
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

// ── Anthropic API response fixture ───────────────────

function makeAnthropicResponse(text: string, tokensIn = 100, tokensOut = 50): string {
    return JSON.stringify({
        content: [{ type: 'text', text }],
        usage: { input_tokens: tokensIn, output_tokens: tokensOut },
        model: 'claude-sonnet-4-20250514',
    });
}

// ── OpenRouter / OpenAI response fixture ─────────────

function makeOpenAiStyleResponse(text: string, promptTokens = 80, completionTokens = 40): string {
    return JSON.stringify({
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
        model: 'gpt-4o',
    });
}

// ── Ollama response fixture ───────────────────────────

function makeOllamaResponse(text: string): string {
    return JSON.stringify({ response: text });
}

// ── Gemini response fixture ───────────────────────────

function makeGeminiResponse(text: string, promptTokens = 70, candidateTokens = 35): string {
    return JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: {
            promptTokenCount: promptTokens,
            candidatesTokenCount: candidateTokens,
        },
    });
}

// ── Env var management ────────────────────────────────

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const originals: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        originals[k] = process.env[k];
        if (v === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = v;
        }
    }
    try {
        fn();
    } finally {
        for (const [k, v] of Object.entries(originals)) {
            if (v === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = v;
            }
        }
    }
}

// ── Tests ─────────────────────────────────────────────

describe('sendPrompt() — provider routing via model string prefix', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('routes "claude/model-name" to the Claude (Anthropic API) provider', async () => {
        setupHttpsMock({ body: makeAnthropicResponse('Claude says hello') });
        process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

        const result = await sendPrompt(
            'claude/claude-sonnet-4-20250514',
            'You are a helpful assistant.',
            'Hello'
        );

        // Verify the HTTPS mock was called (not HTTP, not spawn)
        expect(mockHttpsRequest).toHaveBeenCalled();
        const requestOpts = mockHttpsRequest.mock.calls[0][0] as { hostname: string; path: string };
        expect(requestOpts.hostname).toBe('api.anthropic.com');
        expect(requestOpts.path).toBe('/v1/messages');
        expect(result.text).toBe('Claude says hello');

        delete process.env.ANTHROPIC_API_KEY;
    });

    it('routes "ollama/model-name" to the Ollama provider via HTTP', async () => {
        setupHttpMock({ body: makeOllamaResponse('Ollama says hello') });

        const result = await sendPrompt(
            'ollama/llama3.2',
            'You are a local assistant.',
            'Hello'
        );

        expect(mockHttpRequest).toHaveBeenCalled();
        const requestOpts = mockHttpRequest.mock.calls[0][0] as { hostname: string; path: string };
        expect(requestOpts.hostname).toBe('localhost');
        expect(requestOpts.path).toBe('/api/generate');
        expect(result.text).toBe('Ollama says hello');
    });

    it('defaults to the Claude provider when no provider prefix is given', async () => {
        setupHttpsMock({ body: makeAnthropicResponse('Default provider response') });
        process.env.ANTHROPIC_API_KEY = 'test-key';

        // No slash prefix — should resolve to claude
        await sendPrompt('claude-sonnet-4-20250514', 'System', 'User prompt');

        expect(mockHttpsRequest).toHaveBeenCalled();
        const requestOpts = mockHttpsRequest.mock.calls[0][0] as { hostname: string };
        expect(requestOpts.hostname).toBe('api.anthropic.com');

        delete process.env.ANTHROPIC_API_KEY;
    });

    it('falls back to Claude CLI when ANTHROPIC_API_KEY is absent', async () => {
        const cliOutput = 'CLI response text';
        mockSpawn.mockReturnValue(makeMockProcess(cliOutput) as unknown as ReturnType<typeof childProcess.spawn>);

        delete process.env.ANTHROPIC_API_KEY;

        const result = await sendPrompt(
            'claude/claude-sonnet-4-20250514',
            'System prompt',
            'User prompt'
        );

        expect(mockSpawn).toHaveBeenCalledWith(
            CLAUDE_CLI_TEST_BIN,
            expect.arrayContaining(['--print', expect.any(String)]),
            expect.any(Object)
        );
        expect(result.text).toBe(cliOutput);
        expect(result.model).toBe('claude-cli');
    });

    it('routes "openrouter/model" to OpenRouter and calls the correct endpoint', async () => {
        process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
        setupHttpsMock({ body: makeOpenAiStyleResponse('OpenRouter response') });

        const result = await sendPrompt(
            'openrouter/anthropic/claude-3',
            'System',
            'User'
        );

        expect(mockHttpsRequest).toHaveBeenCalled();
        const opts = mockHttpsRequest.mock.calls[0][0] as { hostname: string; path: string };
        expect(opts.hostname).toBe('openrouter.ai');
        expect(opts.path).toBe('/api/v1/chat/completions');
        expect(result.text).toBe('OpenRouter response');

        delete process.env.OPENROUTER_API_KEY;
    });

    it('routes "openai/model" to the OpenAI API', async () => {
        process.env.OPENAI_API_KEY = 'test-openai-key';
        setupHttpsMock({ body: makeOpenAiStyleResponse('OpenAI response', 90, 45) });

        const result = await sendPrompt('openai/gpt-4o', 'System', 'User');

        const opts = mockHttpsRequest.mock.calls[0][0] as { hostname: string };
        expect(opts.hostname).toBe('api.openai.com');
        expect(result.text).toBe('OpenAI response');

        delete process.env.OPENAI_API_KEY;
    });

    it('routes "gemini/model" to the Gemini API', async () => {
        process.env.GOOGLE_API_KEY = 'test-google-key';
        setupHttpsMock({ body: makeGeminiResponse('Gemini response', 60, 30) });

        const result = await sendPrompt('gemini/gemini-1.5-pro', 'System', 'User');

        const opts = mockHttpsRequest.mock.calls[0][0] as { hostname: string; path: string };
        expect(opts.hostname).toBe('generativelanguage.googleapis.com');
        expect(result.text).toBe('Gemini response');

        delete process.env.GOOGLE_API_KEY;
    });
});

describe('sendPrompt() — missing API key enforcement', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('throws when OPENROUTER_API_KEY is absent', async () => {
        withEnv({ OPENROUTER_API_KEY: undefined }, () => {
            const promise = sendPrompt('openrouter/some-model', 'System', 'User');
            expect(promise).rejects.toThrow('OPENROUTER_API_KEY');
        });
    });

    it('throws when OPENAI_API_KEY is absent', async () => {
        withEnv({ OPENAI_API_KEY: undefined }, () => {
            const promise = sendPrompt('openai/gpt-4o', 'System', 'User');
            expect(promise).rejects.toThrow('OPENAI_API_KEY');
        });
    });

    it('throws when GOOGLE_API_KEY is absent', async () => {
        withEnv({ GOOGLE_API_KEY: undefined }, () => {
            const promise = sendPrompt('gemini/gemini-1.5-pro', 'System', 'User');
            expect(promise).rejects.toThrow('GOOGLE_API_KEY');
        });
    });
});

describe('sendPrompt() — AiResponse shape', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns an AiResponse with text, tokensIn, tokensOut, costUsd, model, and durationMs', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        setupHttpsMock({ body: makeAnthropicResponse('Test output', 120, 60) });

        const result = await sendPrompt(
            'claude/claude-sonnet-4-20250514',
            'System',
            'User prompt'
        );

        expect(result).toMatchObject({
            text: 'Test output',
            tokensIn: 120,
            tokensOut: 60,
            model: 'claude-sonnet-4-20250514',
        });
        expect(typeof result.costUsd).toBe('number');
        expect(typeof result.durationMs).toBe('number');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);

        delete process.env.ANTHROPIC_API_KEY;
    });

    it('calculates a non-zero costUsd for known Claude models', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        setupHttpsMock({ body: makeAnthropicResponse('Cost test', 1000000, 500000) });

        const result = await sendPrompt(
            'claude/claude-sonnet-4-20250514',
            'System',
            'User'
        );

        // With 1M input tokens at $3/M and 500k output tokens at $15/M:
        // cost = (1M * 3 + 500k * 15) / 1M = 3 + 7.5 = 10.5
        expect(result.costUsd).toBeGreaterThan(0);

        delete process.env.ANTHROPIC_API_KEY;
    });

    it('returns costUsd of 0 for Ollama (local models are free)', async () => {
        setupHttpMock({ body: makeOllamaResponse('Free response') });

        const result = await sendPrompt('ollama/llama3.2', 'System', 'User');

        expect(result.costUsd).toBe(0);
    });

    it('returns tokensIn and tokensOut as estimates for Ollama (no usage metadata)', async () => {
        setupHttpMock({ body: makeOllamaResponse('Short reply') });

        const result = await sendPrompt('ollama/llama3.2', 'System prompt', 'User prompt');

        // Ollama uses estimateTokens — both should be positive numbers
        expect(result.tokensIn).toBeGreaterThan(0);
        expect(result.tokensOut).toBeGreaterThan(0);
    });

    it('returns empty text string when provider returns no content', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        const emptyBody = JSON.stringify({
            content: [],
            usage: { input_tokens: 10, output_tokens: 0 },
        });
        setupHttpsMock({ body: emptyBody });

        const result = await sendPrompt('claude/claude-sonnet-4-20250514', 'System', 'User');

        expect(result.text).toBe('');

        delete process.env.ANTHROPIC_API_KEY;
    });
});

describe('sendPrompt() — HTTP error handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects when the API returns a 4xx HTTP status', async () => {
        process.env.ANTHROPIC_API_KEY = 'invalid-key';
        const errorBody = JSON.stringify({ error: { message: 'Invalid API key' } });
        setupHttpsMock({ statusCode: 401, body: errorBody });

        await expect(
            sendPrompt('claude/claude-sonnet-4-20250514', 'System', 'User')
        ).rejects.toThrow(/HTTP 401/);

        delete process.env.ANTHROPIC_API_KEY;
    });

    it('rejects when the API returns a 5xx HTTP status', async () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        setupHttpsMock({ statusCode: 503, body: 'Service Unavailable' });

        await expect(
            sendPrompt('claude/claude-sonnet-4-20250514', 'System', 'User')
        ).rejects.toThrow(/HTTP 503/);

        delete process.env.ANTHROPIC_API_KEY;
    });

    it('rejects when the Claude CLI process exits with a non-zero code', async () => {
        delete process.env.ANTHROPIC_API_KEY;

        const failingProc = new EventEmitter() as NodeJS.EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
        };
        failingProc.stdout = new EventEmitter();
        failingProc.stderr = new EventEmitter();
        failingProc.stdin = { write: vi.fn(), end: vi.fn() };

        setImmediate(() => {
            failingProc.stderr.emit('data', 'Permission denied');
            failingProc.emit('close', 1);
        });

        mockSpawn.mockReturnValue(failingProc as unknown as ReturnType<typeof childProcess.spawn>);

        await expect(
            sendPrompt('claude/some-model', 'System', 'User')
        ).rejects.toThrow(/Process exited with code 1/);
    });
});

describe('sendPrompt() — claude-cli provider (B-022)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('routes "claude-cli/<model>" to spawn "claude" with --model forwarded', async () => {
        const cliOutput = 'Sonnet via subscription CLI';
        mockSpawn.mockReturnValue(makeMockProcess(cliOutput) as unknown as ReturnType<typeof childProcess.spawn>);

        const result = await sendPrompt('claude-cli/sonnet', 'System', 'Hello');

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const [cmd, args] = mockSpawn.mock.calls[0] as unknown as [string, string[], unknown];
        expect(cmd).toBe(CLAUDE_CLI_TEST_BIN);
        expect(args).toEqual(expect.arrayContaining(['--print', '--model', 'sonnet']));

        expect(result.text).toBe(cliOutput);
        expect(result.model).toBe('claude-cli/sonnet');
        // F-363: claude-cli/<model> now reports synthetic Sonnet-rate cost
        // so budget-kill and dashboards have a real signal. The CLI is
        // subscription-billed (operator pays monthly, not per-call), so
        // costUsd is treated as an estimate, not an actual bill.
        expect(result.costUsd).toBeGreaterThan(0);
        expect(result.tokensIn).toBeGreaterThan(0);
        expect(result.tokensOut).toBeGreaterThan(0);
    });

    it('defaults to the bare "claude-cli" provider when no model is given', async () => {
        mockSpawn.mockReturnValue(makeMockProcess('default-cli response') as unknown as ReturnType<typeof childProcess.spawn>);

        const result = await sendPrompt('claude-cli', 'System', 'Hello');

        const [cmd, args] = mockSpawn.mock.calls[0] as unknown as [string, string[], unknown];
        expect(cmd).toBe(CLAUDE_CLI_TEST_BIN);
        // No --model flag is forwarded when the model name is the bare "claude-cli".
        expect(args).not.toContain('--model');
        expect(result.model).toBe('claude-cli');
        // F-363: bare claude-cli also reports synthetic Sonnet-rate cost
        // (the table entry mirrors $3/$15 per M tokens). Treat as estimate.
        expect(result.costUsd).toBeGreaterThan(0);
    });

    it('forwards stdout chunks to options.onStream when a streaming handler is provided', async () => {
        // Build a mock process we control so we can emit multiple chunks explicitly.
        const proc = new EventEmitter() as NodeJS.EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
            kill: ReturnType<typeof vi.fn>;
        };
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = { write: vi.fn(), end: vi.fn() };
        proc.kill = vi.fn();

        setImmediate(() => {
            proc.stdout.emit('data', 'chunk-one ');
            proc.stdout.emit('data', 'chunk-two');
            proc.emit('close', 0);
        });

        mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof childProcess.spawn>);

        const received: string[] = [];
        const result = await sendPrompt(
            'claude-cli/haiku',
            'System',
            'Hello',
            { onStream: (c) => received.push(c) }
        );

        expect(received).toEqual(['chunk-one ', 'chunk-two']);
        expect(result.text).toBe('chunk-one chunk-two');
        expect(result.model).toBe('claude-cli/haiku');
    });

    it('fallback path (claude/<model> without API key) does NOT forward --model', async () => {
        const cliOutput = 'fallback response';
        mockSpawn.mockReturnValue(makeMockProcess(cliOutput) as unknown as ReturnType<typeof childProcess.spawn>);

        delete process.env.ANTHROPIC_API_KEY;

        const result = await sendPrompt(
            'claude/claude-sonnet-4-20250514',
            'System',
            'User'
        );

        const [, args] = mockSpawn.mock.calls[0] as unknown as [string, string[], unknown];
        // Full Anthropic API model IDs are not valid --model values for the CLI,
        // so the fallback path must let the CLI pick its own default.
        expect(args).not.toContain('--model');
        expect(result.model).toBe('claude-cli');
        expect(result.text).toBe(cliOutput);
    });
});

describe('sendPrompt() — Gemini token extraction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('extracts tokensIn and tokensOut from Gemini usageMetadata', async () => {
        process.env.GOOGLE_API_KEY = 'test-google-key';
        setupHttpsMock({ body: makeGeminiResponse('Gemini output', 250, 100) });

        const result = await sendPrompt('gemini/gemini-1.5-pro', 'System', 'User');

        expect(result.tokensIn).toBe(250);
        expect(result.tokensOut).toBe(100);

        delete process.env.GOOGLE_API_KEY;
    });
});

describe('sendPrompt() — OpenAI-style token extraction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('extracts prompt_tokens and completion_tokens from OpenAI response', async () => {
        process.env.OPENAI_API_KEY = 'test-openai-key';
        setupHttpsMock({ body: makeOpenAiStyleResponse('OpenAI output', 300, 150) });

        const result = await sendPrompt('openai/gpt-4o', 'System', 'User');

        expect(result.tokensIn).toBe(300);
        expect(result.tokensOut).toBe(150);

        delete process.env.OPENAI_API_KEY;
    });

    it('extracts prompt_tokens and completion_tokens from OpenRouter response', async () => {
        process.env.OPENROUTER_API_KEY = 'test-or-key';
        setupHttpsMock({ body: makeOpenAiStyleResponse('OR output', 180, 90) });

        const result = await sendPrompt('openrouter/openai/gpt-4o', 'System', 'User');

        expect(result.tokensIn).toBe(180);
        expect(result.tokensOut).toBe(90);

        delete process.env.OPENROUTER_API_KEY;
    });
});
