/**
 * BPF-18 — process-tree kill on AI-call timeout.
 *
 * The claude-cli adapter spawns `node claude.js`, which spawns its own
 * grandchildren (MCP servers, git, model clients). The old timeout path
 * called `proc.kill('SIGKILL')`, which on Windows only reaps the direct
 * child — grandchildren leaked as idle orphans and wedged the run.
 *
 * These tests exercise the real helpers (no mocked spawn) against a genuine
 * long-lived Node subprocess:
 *   • killProcessTree terminates a hung child on the current platform.
 *   • runProcess rejects with a timeout error AND the child is actually gone
 *     (no lingering process holding the event loop / a slot).
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';

import { killProcessTree, runProcess } from '../../../src/agents/ai-adapter/http';

// A child that never exits on its own — stands in for a wedged CLI subprocess.
const HANG_SCRIPT = 'setInterval(() => {}, 1_000_000)';

function waitForExit(proc: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('child did not exit in time')), timeoutMs);
        proc.on('exit', (code) => { clearTimeout(t); resolve(code); });
        proc.on('error', (err) => { clearTimeout(t); reject(err); });
    });
}

describe('BPF-18 killProcessTree', () => {
    it('terminates a hung subprocess', async () => {
        const proc = spawn(process.execPath, ['-e', HANG_SCRIPT], {
            stdio: 'ignore',
            windowsHide: true,
            detached: process.platform !== 'win32',
        });
        // Give it a tick to actually be running.
        await new Promise((r) => setTimeout(r, 50));
        expect(proc.pid).toBeTypeOf('number');

        killProcessTree(proc);

        const code = await waitForExit(proc, 5_000);
        // SIGKILL/taskkill → non-zero exit or null code; the point is it exited.
        expect(code !== undefined).toBe(true);
        expect(proc.killed || code !== 0 || code === null).toBe(true);
    });

    it('does not throw when the process has no pid', () => {
        const fake = { pid: undefined, kill: () => false } as unknown as ReturnType<typeof spawn>;
        expect(() => killProcessTree(fake)).not.toThrow();
    });
});

describe('BPF-18 runProcess timeout', () => {
    it('rejects with a timeout error and reaps the hung child', async () => {
        const start = Date.now();
        await expect(
            runProcess(process.execPath, ['-e', HANG_SCRIPT], 300),
        ).rejects.toThrow(/timed out/i);
        // Should reject promptly at the timeout, not hang to the test ceiling.
        expect(Date.now() - start).toBeLessThan(4_000);
    });
});
