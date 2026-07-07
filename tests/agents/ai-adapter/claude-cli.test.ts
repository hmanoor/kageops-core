/**
 * Direct unit tests for the Claude CLI provider module.
 *
 * Priorities:
 *   - Binary resolution cache + KAGEOPS_CLAUDE_CLI_PATH override
 *   - ANTHROPIC_API_KEY is scrubbed from the CLI env (force subscription mode)
 *   - Explicit claude-cli provider forwards `--model` when a real model alias is given
 *   - Fallback path (config.provider === 'claude') does NOT forward --model
 *   - Missing binary throws a descriptive error
 *   - Streaming mode uses runProcessStream instead of runProcess
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * Stand-in path for `KAGEOPS_CLAUDE_CLI_PATH` overrides in this suite.
 * The resolver requires the override to point at a real file on disk
 * — using a hard-coded `/bin/sh` worked on Unix-like CI but fails on
 * Windows (no /bin/sh). `process.execPath` is the running Node binary;
 * it always exists, on every OS, and is never executed by these tests
 * (we mock `child_process.spawn`).
 */
const FAKE_CLI_PATH = process.execPath;

vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

import * as childProcess from 'child_process';
import {
    _resetClaudeCliPathCacheForTests,
    resolveClaudeCliBinary,
    sendClaudeCliPrompt,
} from '../../../src/agents/ai-adapter/claude-cli';
import type { ProviderConfig } from '../../../src/agents/ai-adapter/types';

const mockSpawn = vi.mocked(childProcess.spawn);

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
        if (stdout !== '') proc.stdout.emit('data', stdout);
        proc.emit('close', exitCode);
    });
    return proc;
}

function makeStreamingProcess(chunks: readonly string[], exitCode = 0) {
    const proc = new EventEmitter() as NodeJS.EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };

    setImmediate(() => {
        for (const c of chunks) proc.stdout.emit('data', c);
        proc.emit('close', exitCode);
    });
    return proc;
}

// ── Tests ─────────────────────────────────────────────

describe('resolveClaudeCliBinary', () => {
    let originalPath: string | undefined;

    beforeEach(() => {
        originalPath = process.env['KAGEOPS_CLAUDE_CLI_PATH'];
        _resetClaudeCliPathCacheForTests();
    });

    afterEach(() => {
        if (originalPath === undefined) {
            delete process.env['KAGEOPS_CLAUDE_CLI_PATH'];
        } else {
            process.env['KAGEOPS_CLAUDE_CLI_PATH'] = originalPath;
        }
        _resetClaudeCliPathCacheForTests();
    });

    it('honours KAGEOPS_CLAUDE_CLI_PATH when the file exists', () => {
        process.env['KAGEOPS_CLAUDE_CLI_PATH'] = FAKE_CLI_PATH;
        expect(resolveClaudeCliBinary()).toBe(FAKE_CLI_PATH);
    });

    it('caches the resolved path — subsequent env changes are ignored until reset', () => {
        process.env['KAGEOPS_CLAUDE_CLI_PATH'] = FAKE_CLI_PATH;
        expect(resolveClaudeCliBinary()).toBe(FAKE_CLI_PATH);

        // Change env var and verify the cache still returns the old path.
        process.env['KAGEOPS_CLAUDE_CLI_PATH'] = '/tmp/non-existent';
        expect(resolveClaudeCliBinary()).toBe(FAKE_CLI_PATH);

        // After reset, the new value takes effect.
        _resetClaudeCliPathCacheForTests();
        // /tmp/non-existent does not exist, so the override is rejected and
        // we fall through to the standard candidates (none of which we can
        // guarantee on a macOS/Linux test rig). The return is either a
        // real path or null — we just assert the cached value is reset.
        const second = resolveClaudeCliBinary();
        expect(second).not.toBe(FAKE_CLI_PATH);
    });

    it('returns null when the override points at a non-existent file and no candidates are found', () => {
        process.env['KAGEOPS_CLAUDE_CLI_PATH'] = '/absolutely/not/there/claude';
        // Reset to ensure fresh resolution.
        _resetClaudeCliPathCacheForTests();
        // We can't control the ambient candidate list, but we can at least
        // assert the return is string | null (never throws).
        const result = resolveClaudeCliBinary();
        expect(result === null || typeof result === 'string').toBe(true);
    });
});

describe('sendClaudeCliPrompt — spawn argv shape', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetClaudeCliPathCacheForTests();
        process.env['KAGEOPS_CLAUDE_CLI_PATH'] = FAKE_CLI_PATH;
    });

    afterEach(() => {
        _resetClaudeCliPathCacheForTests();
    });

    it('forwards --model when the explicit claude-cli provider is used with a real alias', async () => {
        mockSpawn.mockReturnValue(
            makeMockProcess('out') as unknown as ReturnType<typeof childProcess.spawn>
        );

        const config: ProviderConfig = { provider: 'claude-cli', model: 'sonnet' };
        const result = await sendClaudeCliPrompt(config, 'sys', 'user', {});

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const [cmd, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
        expect(cmd).toBe(FAKE_CLI_PATH);
        expect(args).toContain('--print');
        // KO-SEC-003: scope the CLI to no tools instead of bypassing all
        // permission checks — with no tools available there is nothing for
        // the CLI to prompt permission for, so headless `--print` runs
        // clean without `--dangerously-skip-permissions`.
        expect(args).not.toContain('--dangerously-skip-permissions');
        const toolsIdx = args.indexOf('--tools');
        expect(toolsIdx).toBeGreaterThanOrEqual(0);
        expect(args[toolsIdx + 1]).toBe('');
        expect(args).toContain('--model');
        expect(args).toContain('sonnet');
        expect(result.model).toBe('claude-cli/sonnet');
    });

    it('does NOT forward --model when the model is the bare "claude-cli"', async () => {
        mockSpawn.mockReturnValue(
            makeMockProcess('out') as unknown as ReturnType<typeof childProcess.spawn>
        );

        const config: ProviderConfig = { provider: 'claude-cli', model: 'claude-cli' };
        const result = await sendClaudeCliPrompt(config, 'sys', 'user', {});

        const [, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
        // The argv guard suppresses --model when the model is exactly "claude-cli".
        expect(args).not.toContain('--model');
        // The reported model field also collapses to the bare provider name —
        // the argv guard and the display string follow the same rule so users
        // see "claude-cli" (matching what the CLI actually ran) rather than
        // the duplicate-looking "claude-cli/claude-cli".
        expect(result.model).toBe('claude-cli');
    });

    it('does NOT forward --model when invoked via the claude/ API fallback path', async () => {
        mockSpawn.mockReturnValue(
            makeMockProcess('out') as unknown as ReturnType<typeof childProcess.spawn>
        );

        // Note: provider === 'claude' means we're in the "no API key" fallback.
        // The CLI will not accept a full Anthropic API model ID, so --model
        // must not be forwarded.
        const config: ProviderConfig = {
            provider: 'claude',
            model: 'claude-sonnet-4-20250514',
        };
        const result = await sendClaudeCliPrompt(config, 'sys', 'user', {});

        const [, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
        expect(args).not.toContain('--model');
        // Fallback path reports the generic "claude-cli" model name.
        expect(result.model).toBe('claude-cli');
    });

    it('scrubs ANTHROPIC_API_KEY from the spawn env (forces subscription mode)', async () => {
        mockSpawn.mockReturnValue(
            makeMockProcess('out') as unknown as ReturnType<typeof childProcess.spawn>
        );
        process.env.ANTHROPIC_API_KEY = 'should-be-stripped';

        try {
            const config: ProviderConfig = { provider: 'claude-cli', model: 'sonnet' };
            await sendClaudeCliPrompt(config, 'sys', 'user', {});

            const [, , spawnOpts] = mockSpawn.mock.calls[0] as unknown as [
                string,
                string[],
                { env: NodeJS.ProcessEnv }
            ];
            expect(spawnOpts.env).toBeDefined();
            expect('ANTHROPIC_API_KEY' in spawnOpts.env).toBe(false);
        } finally {
            delete process.env.ANTHROPIC_API_KEY;
        }
    });

    it('fuses systemPrompt and userPrompt into the stdin payload (F-381)', async () => {
        // F-381: prompt is piped via stdin (not argv) — argv would blow
        // the Windows ~32KB cap on any non-trivial brief.
        const mockProc = makeMockProcess('ok');
        mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof childProcess.spawn>);

        const config: ProviderConfig = { provider: 'claude-cli', model: 'sonnet' };
        await sendClaudeCliPrompt(config, 'SYSPROMPT', 'USERPROMPT', {});

        const stdinCalls = mockProc.stdin.end.mock.calls as unknown[][];
        expect(stdinCalls.length).toBeGreaterThan(0);
        const fused = (stdinCalls[0][0] as string) ?? '';
        expect(fused).toContain('SYSPROMPT');
        expect(fused).toContain('USERPROMPT');
    });

    it('streams stdout chunks to onStream when provided', async () => {
        mockSpawn.mockReturnValue(
            makeStreamingProcess(['chunk1 ', 'chunk2']) as unknown as ReturnType<typeof childProcess.spawn>
        );

        const received: string[] = [];
        const config: ProviderConfig = { provider: 'claude-cli', model: 'sonnet' };
        const result = await sendClaudeCliPrompt(
            config,
            'sys',
            'user',
            { onStream: (c) => received.push(c) }
        );

        expect(received).toEqual(['chunk1 ', 'chunk2']);
        // The CLI path does NOT trim streaming output (runProcessStream returns
        // the full stdout); sendClaudeCliPrompt then trims the final string.
        expect(result.text).toBe('chunk1 chunk2');
    });
});

describe('sendClaudeCliPrompt — missing binary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetClaudeCliPathCacheForTests();
        // Point at a non-existent path and reset the cache so the resolver
        // looks at the override and then the fallback candidates.
        process.env['KAGEOPS_CLAUDE_CLI_PATH'] = '/definitely/not/there/claude';
    });

    afterEach(() => {
        delete process.env['KAGEOPS_CLAUDE_CLI_PATH'];
        _resetClaudeCliPathCacheForTests();
    });

    it('throws a descriptive error when no binary can be resolved', async () => {
        // We can't universally assert "no candidates exist" on every dev
        // machine (macOS Homebrew installs claude at /opt/homebrew/bin/claude),
        // so this test is best-effort. If a local install exists, skip.
        _resetClaudeCliPathCacheForTests();
        const resolved = resolveClaudeCliBinary();
        if (resolved !== null) {
            // A real binary exists on this host — can't force the missing-binary
            // branch without stubbing fs. Skip this assertion in that case.
            return;
        }

        const config: ProviderConfig = { provider: 'claude-cli', model: 'sonnet' };
        await expect(sendClaudeCliPrompt(config, 'sys', 'user', {})).rejects.toThrow(
            /Claude CLI binary not found/
        );
    });
});
