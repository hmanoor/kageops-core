/**
 * Tests for python-check.ts
 *
 * Tests the uvx/Python availability detection logic.
 * Uses vi.mock to simulate child_process.spawn behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────

const spawnMocks = vi.hoisted(() => ({
    mockSpawn: vi.fn(),
}));

vi.mock('child_process', () => ({
    spawn: spawnMocks.mockSpawn,
}));

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    }),
}));

// ── Import under test (after mocks) ──────────────────

import { checkUvxAvailable, resetUvxCheckForTesting } from '../../src/workspace/python-check';

// ── Helpers ───────────────────────────────────────────

/**
 * Create a mock child process that emits stdout/stderr and closes with the given code.
 */
function makeMockProc(exitCode: number, stdout = '', stderr = '') {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

    const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const stderrListeners: Record<string, ((...args: unknown[]) => void)[]> = {};

    const proc = {
        stdout: {
            on: (event: string, cb: (...args: unknown[]) => void) => {
                stdoutListeners[event] = stdoutListeners[event] ?? [];
                stdoutListeners[event].push(cb);
            },
        },
        stderr: {
            on: (event: string, cb: (...args: unknown[]) => void) => {
                stderrListeners[event] = stderrListeners[event] ?? [];
                stderrListeners[event].push(cb);
            },
        },
        on: (event: string, cb: (...args: unknown[]) => void) => {
            listeners[event] = listeners[event] ?? [];
            listeners[event].push(cb);
        },
        kill: vi.fn(),
        // Helper to trigger events
        _emit: (event: string, ...args: unknown[]) => {
            (listeners[event] ?? []).forEach((cb) => cb(...args));
        },
        _emitStdout: (data: string) => {
            (stdoutListeners['data'] ?? []).forEach((cb) => cb(Buffer.from(data)));
        },
        _emitStderr: (data: string) => {
            (stderrListeners['data'] ?? []).forEach((cb) => cb(Buffer.from(data)));
        },
    };

    // Schedule the close event asynchronously
    setTimeout(() => {
        if (stdout) proc._emitStdout(stdout);
        if (stderr) proc._emitStderr(stderr);
        proc._emit('close', exitCode);
    }, 0);

    return proc;
}

// ── Tests ─────────────────────────────────────────────

describe('checkUvxAvailable', () => {
    beforeEach(() => {
        resetUvxCheckForTesting();
        spawnMocks.mockSpawn.mockReset();
    });

    it('returns uvx method when uvx --version exits 0', async () => {
        spawnMocks.mockSpawn.mockImplementationOnce(() =>
            makeMockProc(0, 'uvx 0.5.1\n')
        );

        const result = await checkUvxAvailable();

        expect(result.available).toBe(true);
        expect(result.method).toBe('uvx');
        expect(result.command).toBe('uvx');
        expect(result.version).toBe('uvx 0.5.1');
    });

    it('falls back to python when uvx is not found', async () => {
        // uvx fails
        spawnMocks.mockSpawn.mockImplementationOnce(() =>
            makeMockProc(1)
        );
        // python succeeds
        spawnMocks.mockSpawn.mockImplementationOnce(() =>
            makeMockProc(0, 'code-review-graph 1.0.0\n')
        );

        const result = await checkUvxAvailable();

        expect(result.available).toBe(true);
        expect(result.method).toBe('python');
        expect(result.command).toBe('python');
    });

    it('returns method=none when neither uvx nor python is found', async () => {
        // uvx, python, python3, py — all fail
        spawnMocks.mockSpawn.mockImplementation(() => makeMockProc(1));

        const result = await checkUvxAvailable();

        expect(result.available).toBe(false);
        expect(result.method).toBe('none');
        expect(result.command).toBe('');
        expect(result.version).toBeNull();
    });

    it('caches the result — spawn called only once across multiple calls', async () => {
        spawnMocks.mockSpawn.mockImplementationOnce(() =>
            makeMockProc(0, 'uvx 0.5.1\n')
        );

        await checkUvxAvailable();
        await checkUvxAvailable();
        await checkUvxAvailable();

        // spawn should only have been called once
        expect(spawnMocks.mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('resetUvxCheckForTesting clears the cache', async () => {
        spawnMocks.mockSpawn.mockImplementation(() => makeMockProc(0, 'uvx 0.5.0\n'));

        await checkUvxAvailable();
        resetUvxCheckForTesting();

        spawnMocks.mockSpawn.mockImplementation(() => makeMockProc(0, 'uvx 0.6.0\n'));
        const result = await checkUvxAvailable();

        expect(result.version).toBe('uvx 0.6.0');
        expect(spawnMocks.mockSpawn).toHaveBeenCalledTimes(2);
    });

    it('uses stderr version when stdout is empty', async () => {
        spawnMocks.mockSpawn.mockImplementationOnce(() =>
            makeMockProc(0, '', 'uvx 0.4.9')
        );

        const result = await checkUvxAvailable();

        expect(result.version).toBe('uvx 0.4.9');
    });

    it('handles spawn() throwing synchronously (command not found in PATH)', async () => {
        spawnMocks.mockSpawn.mockImplementation(() => {
            throw new Error('spawn uvx ENOENT');
        });

        const result = await checkUvxAvailable();

        expect(result.available).toBe(false);
        expect(result.method).toBe('none');
    });
});
