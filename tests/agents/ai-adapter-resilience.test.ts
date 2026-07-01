/**
 * Resilience tests for src/agents/ai-adapter-resilience.ts and the
 * network-retry / null-byte-sanitize hardening in ai-adapter.ts.
 *
 * Covers the three Track A v0.12 fixes:
 *   1. claude-cli null-byte sanitization (prompt argv scrubbed before spawn)
 *   2. Network-transient retry loop (same-model backoff, no cascade)
 *   3. Helpers are pure — no real timers or sockets involved
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Claude CLI path stub — `process.execPath` exists on every OS
// (matches the pattern in ai-adapter.test.ts and claude-{api,cli}.test.ts).
process.env['KAGEOPS_CLAUDE_CLI_PATH'] = process.execPath;

// ── Module mocks ──────────────────────────────────────

vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

vi.mock('https', () => ({
    request: vi.fn(),
}));

vi.mock('http', () => ({
    request: vi.fn(),
}));

vi.mock('../../src/main/provider-key-registry', () => ({
    resolveDefaultKey: vi.fn(async () => null),
}));

vi.mock('../../src/main/secret-store', () => ({
    getApiKey: vi.fn(async (provider: string) => {
        const envMap: Record<string, string> = {
            claude: 'ANTHROPIC_API_KEY',
            openrouter: 'OPENROUTER_API_KEY',
            openai: 'OPENAI_API_KEY',
            gemini: 'GOOGLE_API_KEY',
            ollama: 'OLLAMA_API_KEY',
        };
        const envVar = envMap[provider];
        return envVar !== undefined ? (process.env[envVar] ?? null) : null;
    }),
    setApiKey: vi.fn(),
    hasApiKey: vi.fn(async () => false),
    deleteApiKey: vi.fn(),
    getApiKeyStatus: vi.fn(async () => ({})),
}));

import * as childProcess from 'child_process';
import * as https from 'https';
import {
    stripNullBytes,
    sanitizeSpawnArgs,
    isNetworkTransientError,
    withNetworkRetry,
    onNetworkTransient,
    _resetNetworkTransientListenerForTests,
} from '../../src/agents/ai-adapter-resilience';
import { sendPrompt } from '../../src/agents/ai-adapter';

const mockSpawn = vi.mocked(childProcess.spawn);
const mockHttpsRequest = vi.mocked(https.request);

// ── Helpers ────────────────────────────────────────────

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

// ── stripNullBytes / sanitizeSpawnArgs ────────────────

describe('stripNullBytes', () => {
    it('returns identical string when no nulls present', () => {
        const input = 'hello world';
        expect(stripNullBytes(input)).toBe('hello world');
    });

    it('returns empty string unchanged', () => {
        expect(stripNullBytes('')).toBe('');
    });

    it('removes a single NUL byte', () => {
        expect(stripNullBytes('foo\u0000bar')).toBe('foobar');
    });

    it('removes multiple NUL bytes in one pass', () => {
        expect(stripNullBytes('\u0000a\u0000b\u0000c\u0000')).toBe('abc');
    });

    it('preserves other control characters', () => {
        // \n, \t, \r etc. are valid argv content — only NUL must go.
        const input = 'line1\nline2\ttab\rend\u0000trailing';
        expect(stripNullBytes(input)).toBe('line1\nline2\ttab\rendtrailing');
    });

    it('handles UTF-8 multi-byte characters around nulls', () => {
        expect(stripNullBytes('café\u0000香港')).toBe('café香港');
    });
});

describe('sanitizeSpawnArgs', () => {
    it('passes through a clean argv unchanged', () => {
        const args = ['--print', '--model', 'sonnet', 'hello world'];
        expect(sanitizeSpawnArgs(args)).toEqual(args);
    });

    it('strips NUL bytes from every entry', () => {
        const args = ['--print', '--mo\u0000del', 'sonnet\u0000', 'hel\u0000lo'];
        expect(sanitizeSpawnArgs(args)).toEqual([
            '--print',
            '--model',
            'sonnet',
            'hello',
        ]);
    });

    it('leaves already-clean entries reference-equal or equivalent', () => {
        const clean = 'clean-value';
        const result = sanitizeSpawnArgs([clean]);
        expect(result[0]).toBe(clean);
    });
});

// ── Integration: claude-cli spawn receives null-free argv ───

describe('sendPrompt() — claude-cli null-byte scrubbing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.ANTHROPIC_API_KEY;
    });

    it('strips NUL bytes from the prompt before handing to spawn (B-demo-nullbyte)', async () => {
        // Prompt containing a literal NUL byte — exactly what killed the
        // live demo: `The argument 'args[2]' must be a string without null bytes`.
        const dirtySystemPrompt = 'System\u0000prompt';
        const dirtyUserPrompt = 'User pr\u0000ompt with null bytes\u0000';

        const mockProc = makeMockProcess('CLI output');
        mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof childProcess.spawn>);

        const result = await sendPrompt(
            'claude-cli/sonnet',
            dirtySystemPrompt,
            dirtyUserPrompt
        );

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const [, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];

        // Every argv entry must be free of NUL bytes.
        for (const arg of args) {
            expect(arg.includes('\u0000')).toBe(false);
        }

        // F-381: the fused prompt is on stdin now, not in argv. The stdin
        // payload must still contain the user-intended text with NUL
        // bytes elided (claude-cli.ts scrubs them before pipe).
        const stdinCalls = mockProc.stdin.end.mock.calls as unknown[][];
        expect(stdinCalls.length).toBeGreaterThan(0);
        const fused = (stdinCalls[0][0] as string) ?? '';
        // Use charCode check to avoid embedding a literal NUL in test source.
        let hasNul = false;
        for (let i = 0; i < fused.length; i++) {
            if (fused.charCodeAt(i) === 0) { hasNul = true; break; }
        }
        expect(hasNul).toBe(false);
        expect(fused).toContain('System');
        expect(fused).toContain('prompt');
        expect(fused).toContain('User pr');
        expect(fused).toContain('ompt with null bytes');
        expect(result.text).toBe('CLI output');
    });
});

// ── isNetworkTransientError ───────────────────────────

describe('isNetworkTransientError', () => {
    it('flags ENOTFOUND errors', () => {
        const err = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), {
            code: 'ENOTFOUND',
        });
        expect(isNetworkTransientError(err)).toBe(true);
    });

    it('flags EAI_AGAIN (DNS temporary failure)', () => {
        const err = Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
        expect(isNetworkTransientError(err)).toBe(true);
    });

    it('flags ECONNREFUSED', () => {
        const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        expect(isNetworkTransientError(err)).toBe(true);
    });

    it('flags ETIMEDOUT', () => {
        const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
        expect(isNetworkTransientError(err)).toBe(true);
    });

    it('flags ECONNRESET', () => {
        const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        expect(isNetworkTransientError(err)).toBe(true);
    });

    it('detects by message text when .code is missing (rethrown errors)', () => {
        expect(isNetworkTransientError(new Error('getaddrinfo ENOTFOUND example.com'))).toBe(true);
        expect(isNetworkTransientError(new Error('fetch failed'))).toBe(true);
        expect(isNetworkTransientError(new Error('Request timed out after 5 minutes'))).toBe(true);
    });

    it('treats claude-cli subprocess timeout as transient (P2.3-01)', () => {
        // runProcess() in http.ts rejects with this exact shape after
        // SIGKILL; without recognition the entire AI call fails hard
        // instead of letting withNetworkRetry respawn a fresh subprocess.
        expect(
            isNetworkTransientError(
                new Error('Process timed out after 300s: claude --print')
            )
        ).toBe(true);
    });

    it('does NOT flag HTTP 401 auth errors', () => {
        expect(isNetworkTransientError(new Error('HTTP 401: Invalid API key'))).toBe(false);
    });

    it('does NOT flag HTTP 429 rate limit errors', () => {
        expect(isNetworkTransientError(new Error('HTTP 429: rate_limit exceeded'))).toBe(false);
    });

    it('does NOT flag HTTP 400 bad request', () => {
        expect(isNetworkTransientError(new Error('HTTP 400: bad request'))).toBe(false);
    });

    it('does NOT flag HTTP 500 server errors (those are provider-specific)', () => {
        expect(isNetworkTransientError(new Error('HTTP 503: Service Unavailable'))).toBe(false);
    });

    it('does NOT flag unrelated errors', () => {
        expect(isNetworkTransientError(new Error('Unexpected end of JSON input'))).toBe(false);
        expect(isNetworkTransientError(null)).toBe(false);
        expect(isNetworkTransientError(undefined)).toBe(false);
    });
});

// ── withNetworkRetry loop ─────────────────────────────

describe('withNetworkRetry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        _resetNetworkTransientListenerForTests();
    });

    afterEach(() => {
        vi.useRealTimers();
        _resetNetworkTransientListenerForTests();
    });

    it('returns immediately on success (no retries)', async () => {
        const fn = vi.fn(async () => 'ok');
        const promise = withNetworkRetry('claude/test', fn);
        await vi.runAllTimersAsync();
        await expect(promise).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws immediately on non-network errors (no retry)', async () => {
        const fn = vi.fn(async () => {
            throw new Error('HTTP 401: Invalid API key');
        });
        const promise = withNetworkRetry('claude/test', fn);
        await expect(promise).rejects.toThrow('HTTP 401');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries 3 times on ENOTFOUND then recovers on the 4th attempt', async () => {
        let attempts = 0;
        const fn = vi.fn(async () => {
            attempts += 1;
            if (attempts < 4) {
                throw Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), {
                    code: 'ENOTFOUND',
                });
            }
            return 'recovered';
        });

        const promise = withNetworkRetry('claude/test-model', fn);
        // Advance through all three backoff windows (1s, 3s, 9s).
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(3_000);
        await vi.advanceTimersByTimeAsync(9_000);

        await expect(promise).resolves.toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(4);
    });

    it('gives up after 3 retries (4 total attempts) and surfaces the last error', async () => {
        const fn = vi.fn(async () => {
            throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
        });

        const promise = withNetworkRetry('claude/dead', fn);
        // Swallow expected unhandled-rejection noise while timers advance.
        promise.catch(() => { /* handled below */ });

        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(3_000);
        await vi.advanceTimersByTimeAsync(9_000);
        await vi.runAllTimersAsync();

        await expect(promise).rejects.toThrow(/ENOTFOUND/);
        expect(fn).toHaveBeenCalledTimes(4);
    });

    it('invokes the transient listener with attempt metadata on each retry', async () => {
        const events: Array<{ model: string; attempt: number; delayMs: number }> = [];
        onNetworkTransient((info) => {
            events.push({ model: info.model, attempt: info.attempt, delayMs: info.delayMs });
        });

        let attempts = 0;
        const fn = vi.fn(async () => {
            attempts += 1;
            if (attempts < 3) {
                throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
            }
            return 'ok';
        });

        const promise = withNetworkRetry('claude/hooked', fn);
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(promise).resolves.toBe('ok');

        expect(events).toEqual([
            { model: 'claude/hooked', attempt: 1, delayMs: 1000 },
            { model: 'claude/hooked', attempt: 2, delayMs: 3000 },
        ]);
    });

    it('continues retrying even if the transient listener throws', async () => {
        onNetworkTransient(() => { throw new Error('listener boom'); });

        let attempts = 0;
        const fn = vi.fn(async () => {
            attempts += 1;
            if (attempts < 2) {
                throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
            }
            return 'ok';
        });

        const promise = withNetworkRetry('claude/x', fn);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(promise).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });
});

// ── End-to-end: sendPrompt retries the same model on DNS failure ────

describe('sendPrompt() — network-transient retry (integration)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetNetworkTransientListenerForTests();
        process.env.ANTHROPIC_API_KEY = 'test-key';
    });

    afterEach(() => {
        delete process.env.ANTHROPIC_API_KEY;
        vi.useRealTimers();
    });

    it('retries the SAME Claude API endpoint on ENOTFOUND, then succeeds', async () => {
        // First call throws ENOTFOUND via the req.on('error') path; second
        // call returns a normal 200.
        let callCount = 0;

        mockHttpsRequest.mockImplementation((_opts: unknown, callback: unknown) => {
            callCount += 1;
            const req = new EventEmitter() as NodeJS.EventEmitter & {
                write: ReturnType<typeof vi.fn>;
                end: ReturnType<typeof vi.fn>;
                setTimeout: ReturnType<typeof vi.fn>;
                destroy: ReturnType<typeof vi.fn>;
            };
            req.write = vi.fn();
            req.setTimeout = vi.fn();
            req.destroy = vi.fn();

            if (callCount === 1) {
                // DNS failure path — emit error on next tick.
                req.end = vi.fn().mockImplementation(() => {
                    setImmediate(() => {
                        req.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), {
                            code: 'ENOTFOUND',
                        }));
                    });
                });
            } else {
                // Success path.
                const res = new EventEmitter() as NodeJS.EventEmitter & { statusCode: number };
                res.statusCode = 200;
                req.end = vi.fn().mockImplementation(() => {
                    setImmediate(() => {
                        (callback as (r: unknown) => void)(res);
                        setImmediate(() => {
                            res.emit('data', JSON.stringify({
                                content: [{ type: 'text', text: 'recovered' }],
                                usage: { input_tokens: 10, output_tokens: 5 },
                            }));
                            res.emit('end');
                        });
                    });
                });
            }

            return req as unknown as ReturnType<typeof https.request>;
        });

        vi.useFakeTimers();
        const promise = sendPrompt('claude/claude-sonnet-4-20250514', 'sys', 'hi');
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.runAllTimersAsync();

        const result = await promise;
        expect(result.text).toBe('recovered');
        expect(callCount).toBe(2);
    });
});
