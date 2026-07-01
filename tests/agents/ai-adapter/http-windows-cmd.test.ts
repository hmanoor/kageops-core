/**
 * Tests for the Windows-cmd spawn fix in src/agents/ai-adapter/http.ts.
 *
 * Node 18.20+ / 20+ refuses to spawn `.cmd` / `.bat` / `.ps1` files on
 * Windows without `shell: true` and throws EINVAL (CVE-2024-27980
 * hardening). Both Claude CLI and Codex CLI ship as `%APPDATA%\npm\<name>.cmd`,
 * so the original code path was completely broken on every Windows
 * install with a global-npm CLI.
 *
 * These tests pin the fix shape:
 *   - On Windows + .cmd command, spawn is called with `shell: true`.
 *   - Args are cmd.exe-quoted: doublequotes doubled, whitespace + cmd
 *     metacharacters wrap the arg in surrounding doublequotes.
 *   - Non-Windows paths are untouched.
 *   - Plain .exe binaries on Windows still get no shell.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

import * as childProcess from 'child_process';
import { runProcess, runProcessStream } from '../../../src/agents/ai-adapter/http';

const mockSpawn = vi.mocked(childProcess.spawn);

function makeMockProcess(stdout: string, exitCode = 0) {
    const proc = new EventEmitter() as NodeJS.EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => {
        if (stdout !== '') proc.stdout.emit('data', stdout);
        proc.emit('close', exitCode);
    });
    return proc;
}

describe('runProcess — Windows .cmd handling', () => {
    let origPlatform: PropertyDescriptor | undefined;

    function pretendPlatform(platform: NodeJS.Platform): void {
        origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    }

    afterEach(() => {
        if (origPlatform !== undefined) {
            Object.defineProperty(process, 'platform', origPlatform);
            origPlatform = undefined;
        }
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mockSpawn.mockReturnValue(makeMockProcess('ok') as unknown as ReturnType<typeof childProcess.spawn>);
    });

    it('sets shell:true and quotes args when spawning a .cmd on Windows', async () => {
        pretendPlatform('win32');
        await runProcess('C:\\Users\\me\\npm\\claude.cmd', ['--print', 'hello world']);

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const [cmd, args, opts] = mockSpawn.mock.calls[0] as unknown as [
            string, string[], { shell?: boolean }
        ];
        expect(cmd).toBe('C:\\Users\\me\\npm\\claude.cmd');
        expect(opts.shell).toBe(true);
        // 'hello world' has whitespace → must be quoted.
        expect(args).toContain('"hello world"');
        // '--print' has no special chars → passes through unquoted.
        expect(args).toContain('--print');
    });

    it('doubles internal quotes when quoting cmd.exe args', async () => {
        pretendPlatform('win32');
        // Prompt that contains a literal doublequote inside.
        await runProcess('C:\\npm\\codex.cmd', ['exec', 'Say "hi" please']);

        const [, args] = mockSpawn.mock.calls[0] as unknown as [string, string[], unknown];
        // Internal " → "" per cmd.exe escape; whole arg wrapped in surrounding quotes.
        expect(args).toContain('"Say ""hi"" please"');
    });

    it('does NOT enable shell when the Windows binary is a .exe', async () => {
        pretendPlatform('win32');
        await runProcess('C:\\Program Files\\Claude\\claude.exe', ['--print', 'hi']);

        const [, args, opts] = mockSpawn.mock.calls[0] as unknown as [
            string, string[], { shell?: boolean }
        ];
        expect(opts.shell).toBeUndefined();
        // No quoting either — args pass through untouched.
        expect(args).toEqual(['--print', 'hi']);
    });

    it('does NOT enable shell on Posix even for files ending in .cmd', async () => {
        // Cross-platform sanity check: Posix should never trigger the
        // shell:true workaround, even if someone names a binary `foo.cmd`.
        pretendPlatform('linux');
        await runProcess('/usr/local/bin/claude.cmd', ['--print', 'hi']);

        const [, args, opts] = mockSpawn.mock.calls[0] as unknown as [
            string, string[], { shell?: boolean }
        ];
        expect(opts.shell).toBeUndefined();
        expect(args).toEqual(['--print', 'hi']);
    });

    it('treats .bat and .ps1 like .cmd on Windows', async () => {
        pretendPlatform('win32');
        await runProcess('C:\\bin\\foo.bat', ['arg with space']);
        const optsBat = (mockSpawn.mock.calls[0] as unknown as [string, string[], { shell?: boolean }])[2];
        expect(optsBat.shell).toBe(true);

        mockSpawn.mockClear();
        mockSpawn.mockReturnValue(makeMockProcess('ok') as unknown as ReturnType<typeof childProcess.spawn>);
        await runProcess('C:\\bin\\foo.ps1', ['arg with space']);
        const optsPs1 = (mockSpawn.mock.calls[0] as unknown as [string, string[], { shell?: boolean }])[2];
        expect(optsPs1.shell).toBe(true);
    });
});

describe('runProcessStream — Windows .cmd handling', () => {
    let origPlatform: PropertyDescriptor | undefined;

    afterEach(() => {
        if (origPlatform !== undefined) {
            Object.defineProperty(process, 'platform', origPlatform);
            origPlatform = undefined;
        }
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mockSpawn.mockReturnValue(makeMockProcess('ok') as unknown as ReturnType<typeof childProcess.spawn>);
    });

    it('applies the same shell:true + quoting for .cmd binaries', async () => {
        origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        await runProcessStream(
            'C:\\npm\\claude.cmd',
            ['--print', 'hello world'],
            () => { /* noop */ },
        );

        const [, args, opts] = mockSpawn.mock.calls[0] as unknown as [
            string, string[], { shell?: boolean }
        ];
        expect(opts.shell).toBe(true);
        expect(args).toContain('"hello world"');
    });
});
