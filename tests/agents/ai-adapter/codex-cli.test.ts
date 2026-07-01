/**
 * Direct unit tests for the OpenAI Codex CLI provider module.
 *
 * Mirrors the Claude CLI test suite (tests/agents/ai-adapter/claude-cli.test.ts)
 * because the two providers share the same operational properties — same
 * cwd-isolation pattern (decision #65), same env-scrubbing for subscription
 * mode, same NUL-byte arg sanitisation, same stream forwarding to the Agent
 * Terminal panel.
 *
 * Priorities:
 *   - Binary resolution cache + KAGEOPS_CODEX_CLI_PATH override
 *   - OPENAI_API_KEY is scrubbed from the CLI env (force subscription mode)
 *   - Argv shape: `exec --quiet [--model X] [extra args] <fullPrompt>`
 *   - cwd is forwarded to spawn when options.cwd is set
 *   - Streaming mode uses runProcessStream
 *   - Missing binary throws a descriptive error
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const FAKE_CLI_PATH = process.execPath;

vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    _resetCodexCliPathCacheForTests,
    resolveCodexCliBinary,
    resolveCodexNodeScript,
    sendCodexCliPrompt,
} from '../../../src/agents/ai-adapter/codex-cli';
import type { ProviderConfig } from '../../../src/agents/ai-adapter/types';

const mockSpawn = vi.mocked(childProcess.spawn);

// ── Helpers ─────────────────────────────────────────

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

// ── Tests ───────────────────────────────────────────

describe('resolveCodexCliBinary', () => {
    let originalPath: string | undefined;

    beforeEach(() => {
        originalPath = process.env['KAGEOPS_CODEX_CLI_PATH'];
        _resetCodexCliPathCacheForTests();
    });

    afterEach(() => {
        if (originalPath === undefined) {
            delete process.env['KAGEOPS_CODEX_CLI_PATH'];
        } else {
            process.env['KAGEOPS_CODEX_CLI_PATH'] = originalPath;
        }
        _resetCodexCliPathCacheForTests();
    });

    it('honours KAGEOPS_CODEX_CLI_PATH when the file exists', () => {
        process.env['KAGEOPS_CODEX_CLI_PATH'] = FAKE_CLI_PATH;
        expect(resolveCodexCliBinary()).toBe(FAKE_CLI_PATH);
    });

    it('caches the resolved path — subsequent env changes are ignored until reset', () => {
        process.env['KAGEOPS_CODEX_CLI_PATH'] = FAKE_CLI_PATH;
        expect(resolveCodexCliBinary()).toBe(FAKE_CLI_PATH);

        process.env['KAGEOPS_CODEX_CLI_PATH'] = '/tmp/non-existent';
        expect(resolveCodexCliBinary()).toBe(FAKE_CLI_PATH);

        _resetCodexCliPathCacheForTests();
        const second = resolveCodexCliBinary();
        expect(second).not.toBe(FAKE_CLI_PATH);
    });
});

describe('resolveCodexNodeScript', () => {
    // Build a tmp dir mimicking the npm-global layout so we can verify the
    // .cmd -> codex.js derivation without depending on a real install.
    let tmpRoot: string;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resolve-'));
    });

    afterEach(() => {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
    });

    it('returns the absolute codex.js path when the npm-global layout exists', () => {
        const cmdPath = path.join(tmpRoot, 'codex.cmd');
        const scriptDir = path.join(tmpRoot, 'node_modules', '@openai', 'codex', 'bin');
        const scriptPath = path.join(scriptDir, 'codex.js');
        fs.writeFileSync(cmdPath, '@echo off\n');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(scriptPath, '#!/usr/bin/env node\n');

        expect(resolveCodexNodeScript(cmdPath)).toBe(scriptPath);
    });

    it('returns null when the .cmd has no sibling node_modules/@openai/codex', () => {
        const cmdPath = path.join(tmpRoot, 'codex.cmd');
        fs.writeFileSync(cmdPath, '@echo off\n');
        expect(resolveCodexNodeScript(cmdPath)).toBeNull();
    });

    it('returns null for non-.cmd paths (no-op on POSIX binaries)', () => {
        expect(resolveCodexNodeScript('/usr/local/bin/codex')).toBeNull();
        expect(resolveCodexNodeScript('C:\\Program Files\\codex\\codex.exe')).toBeNull();
    });
});

describe('sendCodexCliPrompt — spawn argv shape', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetCodexCliPathCacheForTests();
        process.env['KAGEOPS_CODEX_CLI_PATH'] = FAKE_CLI_PATH;
    });

    afterEach(() => {
        _resetCodexCliPathCacheForTests();
        delete process.env['KAGEOPS_CODEX_CLI_PATH'];
        delete process.env['KAGEOPS_CODEX_CLI_ARGS'];
    });

    it('wraps the prompt with explicit chat-mode framing for codex exec (piped via stdin since F-381)', async () => {
        // Codex exec treats its input as a single task description. With a
        // long Sensei system prompt followed by a short user message, Codex
        // was reading the system prompt as "the task" and replying
        // 'Understood, I will operate as Sensei…' instead of answering
        // the operator. The fix frames the prompt so Codex understands the
        // user message at the bottom is the actual question.
        //
        // F-381: prompt is now piped via stdin (not argv) — argv would
        // blow the Windows ~32KB cap on any non-trivial brief. Assert
        // against proc.stdin.end()'s payload, not args.
        const mockProc = makeMockProcess('out');
        mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof childProcess.spawn>);

        const config: ProviderConfig = { provider: 'codex-cli', model: 'codex-cli' };
        await sendCodexCliPrompt(
            config,
            'You are Sensei. Be wise.',
            'what projects are running?',
            {},
        );

        // F-381: prompt is the first argument passed to proc.stdin.end()
        const stdinCalls = mockProc.stdin.end.mock.calls as unknown[][];
        expect(stdinCalls.length).toBeGreaterThan(0);
        const prompt = stdinCalls[0][0] as string;
        // Explicit "you are responding to a chat message" task framing must
        // appear FIRST so codex parses it as the directive.
        expect(prompt).toMatch(/^You are responding to an operator chat message/);
        // System prompt is wrapped inside a fenced PERSONA AND RULES block.
        expect(prompt).toContain('=== PERSONA AND RULES ===');
        expect(prompt).toContain('You are Sensei. Be wise.');
        // User message at the END inside its own fence so the model sees
        // it as the question to answer.
        expect(prompt).toContain('=== OPERATOR MESSAGE ===');
        expect(prompt).toContain('what projects are running?');
        // Closing instruction to actually reply (prevents 'Understood'
        // acknowledgements that don't address the question).
        expect(prompt).toMatch(/Write your reply now/);
    });

    it('uses `codex exec --color never --skip-git-repo-check` by default', async () => {
        mockSpawn.mockReturnValue(
            makeMockProcess('out') as unknown as ReturnType<typeof childProcess.spawn>
        );

        const config: ProviderConfig = { provider: 'codex-cli', model: 'codex-cli' };
        await sendCodexCliPrompt(config, 'sys', 'user', {});

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const [cmd, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
        expect(cmd).toBe(FAKE_CLI_PATH);
        expect(args[0]).toBe('exec');
        // --color never strips ANSI sequences so stdout parses cleanly.
        const colorIdx = args.indexOf('--color');
        expect(colorIdx).toBeGreaterThanOrEqual(0);
        expect(args[colorIdx + 1]).toBe('never');
        expect(args).toContain('--skip-git-repo-check');
    });

    it('forwards --model when explicitly provided (e.g. "codex-cli/gpt-5-codex")', async () => {
        mockSpawn.mockReturnValue(
            makeMockProcess('out') as unknown as ReturnType<typeof childProcess.spawn>
        );

        const config: ProviderConfig = { provider: 'codex-cli', model: 'gpt-5-codex' };
        const result = await sendCodexCliPrompt(config, 'sys', 'user', {});

        const [, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
        expect(args).toContain('--model');
        expect(args).toContain('gpt-5-codex');
        expect(result.model).toBe('codex-cli/gpt-5-codex');
    });

    it('does NOT forward --model when the model is the bare "codex-cli"', async () => {
        mockSpawn.mockReturnValue(
            makeMockProcess('out') as unknown as ReturnType<typeof childProcess.spawn>
        );

        const config: ProviderConfig = { provider: 'codex-cli', model: 'codex-cli' };
        await sendCodexCliPrompt(config, 'sys', 'user', {});

        const [, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
        expect(args).not.toContain('--model');
    });

    it('honours KAGEOPS_CODEX_CLI_ARGS extra args', async () => {
        mockSpawn.mockReturnValue(
            makeMockProcess('out') as unknown as ReturnType<typeof childProcess.spawn>
        );
        process.env['KAGEOPS_CODEX_CLI_ARGS'] = '--approval-mode auto-edit';

        const config: ProviderConfig = { provider: 'codex-cli', model: 'codex-cli' };
        await sendCodexCliPrompt(config, 'sys', 'user', {});

        const [, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
        // F-381: prompt is on stdin, not in argv — extras simply need to
        // be present in args. Order vs prompt is no longer meaningful.
        expect(args).toContain('--approval-mode');
        expect(args).toContain('auto-edit');
    });

    it('scrubs OPENAI_API_KEY from the spawn env (forces subscription mode)', async () => {
        mockSpawn.mockReturnValue(
            makeMockProcess('out') as unknown as ReturnType<typeof childProcess.spawn>
        );
        process.env.OPENAI_API_KEY = 'should-be-stripped';

        try {
            const config: ProviderConfig = { provider: 'codex-cli', model: 'codex-cli' };
            await sendCodexCliPrompt(config, 'sys', 'user', {});

            const [, , spawnOpts] = mockSpawn.mock.calls[0] as unknown as [
                string, string[], { env: NodeJS.ProcessEnv }
            ];
            expect(spawnOpts.env).toBeDefined();
            expect('OPENAI_API_KEY' in spawnOpts.env).toBe(false);
        } finally {
            delete process.env.OPENAI_API_KEY;
        }
    });

    it('forwards options.cwd to spawn so the subprocess runs in the project workspace', async () => {
        mockSpawn.mockReturnValue(
            makeMockProcess('out') as unknown as ReturnType<typeof childProcess.spawn>
        );

        const config: ProviderConfig = { provider: 'codex-cli', model: 'codex-cli' };
        await sendCodexCliPrompt(config, 'sys', 'user', { cwd: '/some/project/workspace' });

        const [, , spawnOpts] = mockSpawn.mock.calls[0] as unknown as [
            string, string[], { cwd?: string }
        ];
        expect(spawnOpts.cwd).toBe('/some/project/workspace');
    });

    it('fuses systemPrompt and userPrompt into the stdin payload (F-381)', async () => {
        const mockProc = makeMockProcess('ok');
        mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof childProcess.spawn>);

        const config: ProviderConfig = { provider: 'codex-cli', model: 'codex-cli' };
        await sendCodexCliPrompt(config, 'SYSPROMPT', 'USERPROMPT', {});

        const stdinCalls = mockProc.stdin.end.mock.calls as unknown[][];
        expect(stdinCalls.length).toBeGreaterThan(0);
        const fused = (stdinCalls[0][0] as string) ?? '';
        expect(fused).toContain('SYSPROMPT');
        expect(fused).toContain('USERPROMPT');
    });

    it('streams stdout chunks to onStream when provided', async () => {
        mockSpawn.mockReturnValue(
            makeStreamingProcess(['hello ', 'world']) as unknown as ReturnType<typeof childProcess.spawn>
        );

        const received: string[] = [];
        const config: ProviderConfig = { provider: 'codex-cli', model: 'codex-cli' };
        const result = await sendCodexCliPrompt(
            config, 'sys', 'user',
            { onStream: (c) => received.push(c) }
        );

        expect(received).toEqual(['hello ', 'world']);
        expect(result.text).toBe('hello world');
    });

    // F-363: codex-cli now reports SYNTHETIC cost (operator pays subscription
    // monthly, not per-call, but a real number here trips the budget kill
    // and feeds cost dashboards). Treat the value as an estimate, not a bill.
    it('reports a synthetic costUsd > 0 derived from the underlying API rate (F-363)', async () => {
        mockSpawn.mockReturnValue(
            makeMockProcess('out') as unknown as ReturnType<typeof childProcess.spawn>
        );

        const config: ProviderConfig = { provider: 'codex-cli', model: 'codex-cli' };
        const result = await sendCodexCliPrompt(config, 'sys', 'user', {});

        // Tokens are estimated, not zero — quota burn is real.
        expect(result.tokensIn).toBeGreaterThan(0);
        expect(result.tokensOut).toBeGreaterThan(0);
        // Synthetic cost mirrors o4-equivalent rates → > 0
        expect(result.costUsd).toBeGreaterThan(0);
    });
});

describe('sendCodexCliPrompt — missing binary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetCodexCliPathCacheForTests();
        process.env['KAGEOPS_CODEX_CLI_PATH'] = '/definitely/not/there/codex';
    });

    afterEach(() => {
        delete process.env['KAGEOPS_CODEX_CLI_PATH'];
        _resetCodexCliPathCacheForTests();
    });

    it('throws a descriptive error when no binary can be resolved', async () => {
        _resetCodexCliPathCacheForTests();
        const resolved = resolveCodexCliBinary();
        if (resolved !== null) {
            // A real codex install exists on this dev machine — skip.
            return;
        }

        const config: ProviderConfig = { provider: 'codex-cli', model: 'codex-cli' };
        await expect(sendCodexCliPrompt(config, 'sys', 'user', {})).rejects.toThrow(
            /Codex CLI binary not found/
        );
    });
});

describe('sendCodexCliPrompt — taskkill noise filter (Windows)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetCodexCliPathCacheForTests();
        process.env['KAGEOPS_CODEX_CLI_PATH'] = FAKE_CLI_PATH;
    });

    afterEach(() => {
        _resetCodexCliPathCacheForTests();
        delete process.env['KAGEOPS_CODEX_CLI_PATH'];
    });

    it('strips taskkill SUCCESS lines from stdout before returning', async () => {
        // Real-world Windows output observed by operator on v0.1.2: Codex
        // CLI tears down its MCP child processes with taskkill /T /F and
        // those exit messages bleed into stdout, prepending the actual
        // reply with cleanup noise.
        const noisyOutput = [
            'SUCCESS: The process with PID 53920 (child process of PID 74600) has been terminated.',
            'SUCCESS: The process with PID 74600 (child process of PID 80208) has been terminated.',
            'SUCCESS: The process with PID 80208 (child process of PID 3872) has been terminated.',
            'APO is the Automatic Prompt Optimization scheduler.',
            'It runs nightly when KAGEOPS_APO_ENABLED=1.',
        ].join('\n');

        mockSpawn.mockReturnValue(
            makeMockProcess(noisyOutput) as unknown as ReturnType<typeof childProcess.spawn>
        );

        const config: ProviderConfig = { provider: 'codex-cli', model: 'codex-cli' };
        const result = await sendCodexCliPrompt(config, 'sys', 'user', {});

        // Cleanup lines stripped, actual reply preserved verbatim.
        expect(result.text).not.toMatch(/SUCCESS: The process with PID/);
        expect(result.text).toContain('APO is the Automatic Prompt Optimization scheduler.');
        expect(result.text).toContain('It runs nightly when KAGEOPS_APO_ENABLED=1.');
    });

    it('preserves lines that mention "PID" but are not the exact taskkill format', async () => {
        // Defensive: a model reply that legitimately discusses PIDs (e.g.
        // operator asks Sensei about a hung process) must NOT be eaten by
        // the filter. Only the precise taskkill format matches.
        const output = [
            'You can find the orchestrator PID in agent_logs.',
            'SUCCESS: The process completed without error.', // similar prefix, DIFFERENT shape
            'Done.',
        ].join('\n');

        mockSpawn.mockReturnValue(
            makeMockProcess(output) as unknown as ReturnType<typeof childProcess.spawn>
        );

        const config: ProviderConfig = { provider: 'codex-cli', model: 'codex-cli' };
        const result = await sendCodexCliPrompt(config, 'sys', 'user', {});

        expect(result.text).toContain('You can find the orchestrator PID in agent_logs.');
        expect(result.text).toContain('SUCCESS: The process completed without error.');
        expect(result.text).toContain('Done.');
    });
});
