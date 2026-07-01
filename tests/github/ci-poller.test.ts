/**
 * Tests for ci-poller.ts
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CIPoller } from '../../src/github/ci-poller';

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    }),
}));

vi.mock('../../src/db/client', () => ({
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

// ── Helpers ───────────────────────────────────────────

function makeCheckRun(status: string, conclusion: string | null) {
    return { id: Math.random(), name: 'build', status, conclusion, html_url: 'x' };
}

function makeClient(checkRunsResponse = { total_count: 0, check_runs: [] as object[] }) {
    return {
        getCheckRuns: vi.fn(async () => checkRunsResponse),
        pushBranch: vi.fn(),
        createPullRequest: vi.fn(),
        triggerWorkflowDispatch: vi.fn(),
        validateToken: vi.fn(),
        rateLimitInfo: { remaining: 5000, resetAt: 0 },
    };
}

function makeEventBus() {
    return {
        publish: vi.fn(async () => undefined),
        subscribe: vi.fn(async () => undefined),
    };
}

const CONFIG = { owner: 'owner', repo: 'repo', token: 'token' };

// ── Tests ─────────────────────────────────────────────

describe('CIPoller', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('emits build.passed when all checks succeed', async () => {
        const client = makeClient({
            total_count: 2,
            check_runs: [
                makeCheckRun('completed', 'success'),
                makeCheckRun('completed', 'success'),
            ],
        });
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const poller = new CIPoller(client as any, eventBus as any);

        poller.pollForCompletion(CONFIG, 'sha-pass', 'proj-1', 'task-1');

        // Let the immediate tick run
        await vi.runAllTimersAsync();
        await vi.runAllTimersAsync();

        expect(eventBus.publish).toHaveBeenCalledWith(
            'build.passed',
            expect.objectContaining({ projectId: 'proj-1', taskId: 'task-1' })
        );
    });

    it('emits build.failed when any check fails', async () => {
        const client = makeClient({
            total_count: 2,
            check_runs: [
                makeCheckRun('completed', 'success'),
                makeCheckRun('completed', 'failure'),
            ],
        });
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const poller = new CIPoller(client as any, eventBus as any);

        poller.pollForCompletion(CONFIG, 'sha-fail', 'proj-2', 'task-2');

        await vi.runAllTimersAsync();
        await vi.runAllTimersAsync();

        expect(eventBus.publish).toHaveBeenCalledWith(
            'build.failed',
            expect.objectContaining({ projectId: 'proj-2' })
        );
    });

    it('does not emit while checks are in_progress', async () => {
        const client = makeClient({
            total_count: 1,
            check_runs: [makeCheckRun('in_progress', null)],
        });
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const poller = new CIPoller(client as any, eventBus as any);

        poller.pollForCompletion(CONFIG, 'sha-running', 'proj-3', 'task-3');

        // Advance one poll interval (30s) — still in_progress, no emit
        await vi.advanceTimersByTimeAsync(31_000);
        // Wait for any async microtasks
        await Promise.resolve();

        expect(eventBus.publish).not.toHaveBeenCalled();

        // Clean up
        poller.stopAll();
    });

    it('emits build.failed on max duration timeout', async () => {
        // Return in_progress forever
        const client = makeClient({
            total_count: 1,
            check_runs: [makeCheckRun('in_progress', null)],
        });
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const poller = new CIPoller(client as any, eventBus as any);

        poller.pollForCompletion(CONFIG, 'sha-timeout', 'proj-4', 'task-4');

        // Advance past 20 minutes
        await vi.advanceTimersByTimeAsync(21 * 60_000);
        await vi.runAllTimersAsync();

        expect(eventBus.publish).toHaveBeenCalledWith(
            'build.failed',
            expect.objectContaining({ projectId: 'proj-4' })
        );
    });

    it('ignores duplicate poll for same SHA', async () => {
        const client = makeClient({ total_count: 0, check_runs: [] });
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const poller = new CIPoller(client as any, eventBus as any);

        poller.pollForCompletion(CONFIG, 'sha-dup', 'proj-5', 'task-5');
        poller.pollForCompletion(CONFIG, 'sha-dup', 'proj-5', 'task-5');

        expect(poller.activePollCount).toBe(1);
    });

    it('stopAll() cancels all active polls', async () => {
        const client = makeClient({ total_count: 0, check_runs: [] });
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const poller = new CIPoller(client as any, eventBus as any);

        poller.pollForCompletion(CONFIG, 'sha-a', 'proj-1', 'task-1');
        poller.pollForCompletion(CONFIG, 'sha-b', 'proj-2', 'task-2');
        expect(poller.activePollCount).toBe(2);

        poller.stopAll();
        expect(poller.activePollCount).toBe(0);
    });

    it('emits build.passed (no CI) after 5 minutes with no checks', async () => {
        const client = makeClient({ total_count: 0, check_runs: [] });
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const poller = new CIPoller(client as any, eventBus as any);

        poller.pollForCompletion(CONFIG, 'sha-noci', 'proj-6', 'task-6');

        // Advance past 5 minutes
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        await vi.runAllTimersAsync();

        expect(eventBus.publish).toHaveBeenCalledWith(
            'build.passed',
            expect.objectContaining({ projectId: 'proj-6' })
        );
    });
});
