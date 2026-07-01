/**
 * Nightly APO Scheduler — unit tests
 *
 * Exercises `runApoForAgent`, `runApoForAllEligible`, and the
 * `startApoScheduler` timer loop with fully-injected deps so the suite
 * never touches Postgres, network, or fs.
 */

import { describe, it, expect, vi } from 'vitest';

import {
    runApoForAgent,
    runApoForAllEligible,
    startApoScheduler,
    type ApoSchedulerDeps,
} from '../../src/learning/apo-scheduler';
import type { OptimizationResult, PromptOptimizationRecord } from '../../src/learning/types';
import type { SampleTask } from '../../src/learning/apo-engine';

// ── Fixtures ──────────────────────────────────────────

const GOLDEN_TASKS: readonly SampleTask[] = [
    { id: 't1', description: 'sample task 1' },
    { id: 't2', description: 'sample task 2' },
];

function makePersistMock(): {
    readonly fn: ApoSchedulerDeps['persistOptimization'];
    readonly calls: Array<{ result: OptimizationResult; nSamples: number }>;
} {
    const calls: Array<{ result: OptimizationResult; nSamples: number }> = [];
    const fn: ApoSchedulerDeps['persistOptimization'] = async (result, { nSamples }) => {
        calls.push({ result, nSamples });
        const record: PromptOptimizationRecord = Object.freeze({
            id: `row-${calls.length}`,
            agentName: result.agentName,
            baselinePrompt: result.baselinePrompt,
            optimizedPrompt: result.winner,
            baselineReward: result.baselineReward,
            optimizedReward: result.winnerReward,
            rewardDelta: result.delta,
            beamWidth: result.beamWidth,
            branchFactor: result.branchFactor,
            rounds: result.rounds,
            nSamples,
            status: 'proposed',
            createdAt: '2026-04-21T00:00:00.000Z',
            appliedAt: null,
        });
        return record;
    };
    return { fn, calls };
}

function makeDeps(overrides: Partial<ApoSchedulerDeps> = {}): ApoSchedulerDeps {
    return {
        loadBaselinePrompt: () => 'baseline prompt',
        loadGoldenTasks: () => GOLDEN_TASKS,
        sendPrompt: async () => ({ text: 'ok', costUsd: 0, tokensOut: 10 }),
        model: 'fake-model',
        // Deterministic evaluator: score = length of the prompt so longer
        // prompts win. The mutator below appends a suffix each round, so
        // mutants always score strictly higher than baseline.
        evaluatorFactory: () => async (prompt: string): Promise<number> => prompt.length,
        persistOptimization: makePersistMock().fn,
        ...overrides,
    };
}

// Mock the prompt mutator so optimize() produces growing candidates deterministically.
// This makes scoring predictable without an actual LLM.
vi.mock('../../src/learning/prompt-mutator', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../../src/learning/prompt-mutator')>();
    return {
        ...mod,
        mutatePrompt: async (parent: string): Promise<string> => `${parent}!`,
    };
});

// ── runApoForAgent ────────────────────────────────────

describe('runApoForAgent', () => {
    const DEFAULT_OPTS = { beamWidth: 2, branchFactor: 2, rounds: 2, minDelta: 0.01 };

    it('persists when delta exceeds minDelta', async () => {
        const persist = makePersistMock();
        const deps = makeDeps({ persistOptimization: persist.fn });

        const outcome = await runApoForAgent('scout', deps, DEFAULT_OPTS);

        expect(outcome.status).toBe('persisted');
        expect(outcome.optimizationId).toBe('row-1');
        expect(outcome.agentName).toBe('scout');
        expect(outcome.nSamples).toBe(GOLDEN_TASKS.length);
        expect(outcome.error).toBeNull();
        expect(persist.calls).toHaveLength(1);
        expect(persist.calls[0]!.result.agentName).toBe('scout');
        expect(persist.calls[0]!.nSamples).toBe(GOLDEN_TASKS.length);
    });

    it('skips persistence when delta < minDelta (1e6 threshold forces below-threshold)', async () => {
        const persist = makePersistMock();
        const deps = makeDeps({ persistOptimization: persist.fn });

        const outcome = await runApoForAgent('scout', deps, {
            ...DEFAULT_OPTS,
            minDelta: 1_000_000,
        });

        expect(outcome.status).toBe('below-threshold');
        expect(outcome.delta).not.toBeNull();
        expect(outcome.delta!).toBeLessThan(1_000_000);
        expect(outcome.optimizationId).toBeNull();
        expect(persist.calls).toHaveLength(0);
    });

    it('skips when the agent is not APO-eligible (does not touch loaders or persister)', async () => {
        const persist = makePersistMock();
        const baselineLoader = vi.fn(() => 'some baseline');
        const tasksLoader = vi.fn(() => GOLDEN_TASKS);
        const deps = makeDeps({
            persistOptimization: persist.fn,
            loadBaselinePrompt: baselineLoader,
            loadGoldenTasks: tasksLoader,
        });

        const outcome = await runApoForAgent('forge', deps, DEFAULT_OPTS);

        expect(outcome.status).toBe('skipped');
        expect(outcome.error).toContain('not APO-eligible');
        expect(baselineLoader).not.toHaveBeenCalled();
        expect(tasksLoader).not.toHaveBeenCalled();
        expect(persist.calls).toHaveLength(0);
    });

    it('skips when baseline prompt is null', async () => {
        const persist = makePersistMock();
        const deps = makeDeps({
            persistOptimization: persist.fn,
            loadBaselinePrompt: () => null,
        });

        const outcome = await runApoForAgent('scout', deps, DEFAULT_OPTS);

        expect(outcome.status).toBe('skipped');
        expect(outcome.error).toContain('missing baseline');
        expect(persist.calls).toHaveLength(0);
    });

    it('skips when baseline prompt is empty string', async () => {
        const persist = makePersistMock();
        const deps = makeDeps({
            persistOptimization: persist.fn,
            loadBaselinePrompt: () => '   ',
        });

        const outcome = await runApoForAgent('scout', deps, DEFAULT_OPTS);

        expect(outcome.status).toBe('skipped');
        expect(outcome.error).toContain('missing baseline');
        expect(persist.calls).toHaveLength(0);
    });

    it('skips when golden tasks are empty', async () => {
        const persist = makePersistMock();
        const deps = makeDeps({
            persistOptimization: persist.fn,
            loadGoldenTasks: () => [],
        });

        const outcome = await runApoForAgent('scout', deps, DEFAULT_OPTS);

        expect(outcome.status).toBe('skipped');
        expect(outcome.error).toContain('no golden tasks');
        expect(persist.calls).toHaveLength(0);
    });

    it('catches and reports errors from the evaluator', async () => {
        const persist = makePersistMock();
        const deps = makeDeps({
            persistOptimization: persist.fn,
            evaluatorFactory: () => async () => {
                throw new Error('eval blew up');
            },
        });

        const outcome = await runApoForAgent('scout', deps, DEFAULT_OPTS);

        expect(outcome.status).toBe('error');
        expect(outcome.error).toContain('eval blew up');
        expect(persist.calls).toHaveLength(0);
    });

    it('catches and reports errors from the persister', async () => {
        const deps = makeDeps({
            persistOptimization: async () => {
                throw new Error('db offline');
            },
        });

        const outcome = await runApoForAgent('scout', deps, DEFAULT_OPTS);

        expect(outcome.status).toBe('error');
        expect(outcome.error).toContain('db offline');
    });

    it('forwards beam/branch/rounds into the engine', async () => {
        const persist = makePersistMock();
        const deps = makeDeps({ persistOptimization: persist.fn });

        await runApoForAgent('scout', deps, {
            beamWidth: 3,
            branchFactor: 4,
            rounds: 2,
            minDelta: 0.01,
        });

        expect(persist.calls[0]!.result.beamWidth).toBe(3);
        expect(persist.calls[0]!.result.branchFactor).toBe(4);
        expect(persist.calls[0]!.result.rounds).toBe(2);
    });
});

// ── runApoForAllEligible ──────────────────────────────

describe('runApoForAllEligible', () => {
    it('runs every eligible agent and aggregates outcomes', async () => {
        const persist = makePersistMock();
        const deps = makeDeps({ persistOptimization: persist.fn });

        const report = await runApoForAllEligible(deps, {
            beamWidth: 2,
            branchFactor: 2,
            rounds: 2,
            minDelta: 0.01,
        });

        expect(report.outcomes).toHaveLength(3); // scout, herald, pixel
        expect(report.outcomes.map((o) => o.agentName).sort()).toEqual(
            ['herald', 'pixel', 'scout']
        );
        expect(report.outcomes.every((o) => o.status === 'persisted')).toBe(true);
        expect(report.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(report.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('continues through failures in individual agents', async () => {
        const persist = makePersistMock();
        const baselineLoader = (name: string): string | null =>
            name === 'herald' ? null : 'baseline';
        const deps = makeDeps({
            persistOptimization: persist.fn,
            loadBaselinePrompt: baselineLoader,
        });

        const report = await runApoForAllEligible(deps, {
            beamWidth: 2,
            branchFactor: 2,
            rounds: 2,
            minDelta: 0.01,
        });

        const byAgent = new Map(report.outcomes.map((o) => [o.agentName, o]));
        expect(byAgent.get('scout')?.status).toBe('persisted');
        expect(byAgent.get('herald')?.status).toBe('skipped');
        expect(byAgent.get('pixel')?.status).toBe('persisted');
    });

    it('respects custom agents list', async () => {
        const persist = makePersistMock();
        const deps = makeDeps({ persistOptimization: persist.fn });

        const report = await runApoForAllEligible(deps, {
            beamWidth: 2, branchFactor: 2, rounds: 2, minDelta: 0.01,
            agents: ['scout'],
        });

        expect(report.outcomes).toHaveLength(1);
        expect(report.outcomes[0]!.agentName).toBe('scout');
        expect(persist.calls).toHaveLength(1);
    });
});

// ── startApoScheduler ────────────────────────────────

describe('startApoScheduler', () => {
    // Uses real timers with tiny intervals so we can observe actual async
    // settlement. Each test creates a promise that resolves from the
    // `onRunComplete` callback — no microtask juggling.

    function nextRun(): { readonly onComplete: (r: ApoReportShape) => void; readonly waitFor: (n?: number) => Promise<ApoReportShape> } {
        const reports: ApoReportShape[] = [];
        const waiters: Array<{ n: number; resolve: (r: ApoReportShape) => void }> = [];
        const onComplete = (r: ApoReportShape): void => {
            reports.push(r);
            for (const w of waiters) {
                if (reports.length >= w.n) w.resolve(reports[w.n - 1]!);
            }
        };
        const waitFor = (n: number = 1): Promise<ApoReportShape> => {
            if (reports.length >= n) return Promise.resolve(reports[n - 1]!);
            return new Promise<ApoReportShape>((resolve) => {
                waiters.push({ n, resolve });
            });
        };
        return { onComplete, waitFor };
    }

    it('fires the first run after initialDelayMs and records lastReport', async () => {
        const persist = makePersistMock();
        const deps = makeDeps({ persistOptimization: persist.fn });
        const { onComplete, waitFor } = nextRun();

        const handle = startApoScheduler(deps, {
            beamWidth: 2, branchFactor: 2, rounds: 2, minDelta: 0.01,
            initialDelayMs: 5,
            intervalMs: 60_000,
            onRunComplete: onComplete,
        });

        expect(handle.lastReport()).toBeNull();

        const report = await waitFor();
        expect(report.outcomes).toHaveLength(3);
        expect(handle.lastReport()).not.toBeNull();
        handle.stop();
    });

    it('fires immediately when runImmediately is true', async () => {
        const persist = makePersistMock();
        const deps = makeDeps({ persistOptimization: persist.fn });
        const { onComplete, waitFor } = nextRun();

        const handle = startApoScheduler(deps, {
            beamWidth: 2, branchFactor: 2, rounds: 2, minDelta: 0.01,
            runImmediately: true,
            intervalMs: 60_000,
            onRunComplete: onComplete,
        });

        const report = await waitFor();
        expect(report.outcomes).toHaveLength(3);
        handle.stop();
    });

    it('stop() prevents further runs', async () => {
        const persist = makePersistMock();
        const deps = makeDeps({ persistOptimization: persist.fn });
        const { onComplete, waitFor } = nextRun();

        const handle = startApoScheduler(deps, {
            beamWidth: 2, branchFactor: 2, rounds: 2, minDelta: 0.01,
            runImmediately: true,
            intervalMs: 10, // very short so the second tick would fire fast
            onRunComplete: onComplete,
        });

        await waitFor();
        const firstCallCount = persist.calls.length;
        expect(firstCallCount).toBeGreaterThan(0);

        handle.stop();

        // Wait longer than the interval to ensure no second run fires.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(persist.calls.length).toBe(firstCallCount);
    });

    it('continues scheduling even after a tick crashes', async () => {
        let shouldFail = true;
        const calls: number[] = [];
        const persist: ApoSchedulerDeps['persistOptimization'] = async (_r, { nSamples }) => {
            calls.push(nSamples);
            if (shouldFail) {
                shouldFail = false;
                throw new Error('db transient');
            }
            return {
                id: `row-${calls.length}`,
                agentName: 'scout',
                baselinePrompt: 'x', optimizedPrompt: 'y',
                baselineReward: 0, optimizedReward: 0, rewardDelta: 0.5,
                beamWidth: 2, branchFactor: 2, rounds: 2, nSamples,
                status: 'proposed' as const,
                createdAt: '2026-04-21T00:00:00.000Z',
                appliedAt: null,
            };
        };
        const deps = makeDeps({ persistOptimization: persist });
        const { onComplete, waitFor } = nextRun();

        const handle = startApoScheduler(deps, {
            beamWidth: 2, branchFactor: 2, rounds: 2, minDelta: 0.01,
            runImmediately: true,
            intervalMs: 5,
            agents: ['scout'],
            onRunComplete: onComplete,
        });

        const first = await waitFor(1);
        expect(first.outcomes[0]!.status).toBe('error');

        const second = await waitFor(2);
        expect(second.outcomes[0]!.status).toBe('persisted');

        handle.stop();
    });
});

// Minimal structural alias so nextRun's waiter callbacks stay typed without
// pulling in the full type chain.
type ApoReportShape = Awaited<ReturnType<typeof runApoForAllEligible>>;
