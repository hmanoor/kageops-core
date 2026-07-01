/**
 * Tests for src/learning/live-eval.ts (B-471)
 *
 * Covers:
 *   1. Empty task set → reward 0 (no signal)
 *   2. All tasks succeed → mean reward reflects the success formula
 *   3. One task fails → reward blends success + failure penalty
 *   4. Budget cap triggered mid-eval → remaining tasks skipped (scored -0.5)
 *   5. Empty LLM response → 'escalated' outcome (-0.2)
 *   6. Truncated response (tokensOut >= maxTokens) → 'escalated'
 *   7. LLM throws → 'failed' outcome, eval continues
 *   8. Per-task timeout fires → 'failed' outcome
 *   9. onTaskResult observer is called for every task (including skipped)
 *  10. Reward signal feeds APO — higher reward on cheaper candidate
 */

import { describe, expect, it } from 'vitest';
import { createLiveEvaluator, type TaskOutcome } from '../../src/learning/live-eval';
import type { SampleTask } from '../../src/learning/apo-engine';
import type { SendPromptFn } from '../../src/learning/prompt-mutator';

// ── Fixtures ─────────────────────────────────────────

const TASKS: readonly SampleTask[] = Object.freeze([
    { id: 't1', description: 'write a 1-sentence summary of beam search' },
    { id: 't2', description: 'name three beam-search hyperparameters' },
]);

function makeSender(responses: ReadonlyArray<{
    text: string;
    costUsd?: number;
    tokensOut?: number;
    throwError?: string;
}>): SendPromptFn {
    let idx = 0;
    return async () => {
        const r = responses[idx++];
        if (r === undefined) {
            throw new Error('sender called more times than scripted');
        }
        if (r.throwError !== undefined) {
            throw new Error(r.throwError);
        }
        return {
            text: r.text,
            costUsd: r.costUsd ?? 0.01,
            tokensOut: r.tokensOut ?? 50,
        };
    };
}

// ── Tests ────────────────────────────────────────────

describe('createLiveEvaluator', () => {
    it('returns 0 for an empty task set (no signal)', async () => {
        const evalFn = createLiveEvaluator({
            sendPrompt: makeSender([]),
            model: 'test-model',
        });
        const reward = await evalFn('candidate', []);
        expect(reward).toBe(0);
    });

    it('scores all-success runs with the cost-penalty formula', async () => {
        // costUsd=0.01 → penalty = min(0.04, 0.8) = 0.04 → reward = 0.96
        const evalFn = createLiveEvaluator({
            sendPrompt: makeSender([
                { text: 'beam search is a heuristic tree search.', costUsd: 0.01 },
                { text: 'beamWidth, branchFactor, rounds.', costUsd: 0.01 },
            ]),
            model: 'test-model',
        });
        const reward = await evalFn('candidate prompt', TASKS);
        expect(reward).toBeCloseTo(0.96, 3);
    });

    it('blends success and failure rewards when one task errors', async () => {
        // t1 succeeds (cost 0.01 → reward 0.96), t2 throws → reward -0.5
        // mean = (0.96 + -0.5) / 2 = 0.23
        const evalFn = createLiveEvaluator({
            sendPrompt: makeSender([
                { text: 'ok', costUsd: 0.01 },
                { throwError: 'provider down', text: '' },
            ]),
            model: 'test-model',
        });
        const reward = await evalFn('candidate prompt', TASKS);
        expect(reward).toBeCloseTo(0.23, 3);
    });

    it('skips remaining tasks once the budget cap is breached', async () => {
        const longer: readonly SampleTask[] = Object.freeze([
            { id: 't1', description: 'q1' },
            { id: 't2', description: 'q2' },
            { id: 't3', description: 'q3' },
        ]);
        const observed: TaskOutcome[] = [];
        // Two expensive tasks that alone exceed 0.05 — the third must skip.
        const evalFn = createLiveEvaluator({
            sendPrompt: makeSender([
                { text: 'ok', costUsd: 0.03 },
                { text: 'ok', costUsd: 0.03 },
                // Third response should NEVER be consumed.
                { text: 'should not be called', costUsd: 999 },
            ]),
            model: 'test-model',
            budgetCapUsd: 0.05,
            onTaskResult: (_task, outcome) => observed.push(outcome),
        });
        await evalFn('candidate', longer);
        expect(observed).toHaveLength(3);
        expect(observed[0]?.status).toBe('success');
        expect(observed[1]?.status).toBe('success');
        expect(observed[2]?.status).toBe('skipped');
        expect(observed[2]?.reward).toBe(-0.5);
    });

    it('scores an empty LLM response as escalated (-0.2)', async () => {
        const evalFn = createLiveEvaluator({
            sendPrompt: makeSender([
                { text: '', costUsd: 0.001 },
                { text: 'normal output', costUsd: 0.01 },
            ]),
            model: 'test-model',
        });
        const reward = await evalFn('candidate', TASKS);
        // (-0.2 + 0.96) / 2 = 0.38
        expect(reward).toBeCloseTo(0.38, 3);
    });

    it('scores truncated responses (tokensOut >= maxTokens) as escalated', async () => {
        const evalFn = createLiveEvaluator({
            sendPrompt: makeSender([
                { text: 'a long response that hit the cap', costUsd: 0.01, tokensOut: 128 },
                { text: 'normal', costUsd: 0.01, tokensOut: 50 },
            ]),
            model: 'test-model',
            maxTokens: 128,
        });
        const observed: TaskOutcome[] = [];
        const evalFnWithObserver = createLiveEvaluator({
            sendPrompt: makeSender([
                { text: 'a long response that hit the cap', costUsd: 0.01, tokensOut: 128 },
                { text: 'normal', costUsd: 0.01, tokensOut: 50 },
            ]),
            model: 'test-model',
            maxTokens: 128,
            onTaskResult: (_t, o) => observed.push(o),
        });
        await evalFnWithObserver('c', TASKS);
        expect(observed[0]?.status).toBe('escalated');
        expect(observed[1]?.status).toBe('success');
        // Sanity: reward ≈ (-0.2 + 0.96) / 2 = 0.38
        const reward = await evalFn('c', TASKS);
        expect(reward).toBeCloseTo(0.38, 3);
    });

    it('does not abort the full eval when one task throws', async () => {
        const observed: TaskOutcome[] = [];
        const evalFn = createLiveEvaluator({
            sendPrompt: makeSender([
                { throwError: 'boom', text: '' },
                { text: 'ok', costUsd: 0.01 },
            ]),
            model: 'test-model',
            onTaskResult: (_t, o) => observed.push(o),
        });
        const reward = await evalFn('c', TASKS);
        expect(observed).toHaveLength(2);
        expect(observed[0]?.status).toBe('failed');
        expect(observed[0]?.error).toContain('boom');
        expect(observed[1]?.status).toBe('success');
        // (-0.5 + 0.96) / 2 = 0.23
        expect(reward).toBeCloseTo(0.23, 3);
    });

    it('penalizes a candidate that times out per-task', async () => {
        const observed: TaskOutcome[] = [];
        // Slow sender — never resolves within the timeout.
        const slowSender: SendPromptFn = () =>
            new Promise((resolve) => {
                // Resolve after 200ms; timeout is 50ms so it should lose.
                setTimeout(
                    () =>
                        resolve({
                            text: 'too slow',
                            costUsd: 0.001,
                            tokensOut: 1,
                        }),
                    200
                );
            });
        const evalFn = createLiveEvaluator({
            sendPrompt: slowSender,
            model: 'test-model',
            perTaskTimeoutMs: 50,
            onTaskResult: (_t, o) => observed.push(o),
        });
        const reward = await evalFn('c', [{ id: 't1', description: 'q' }]);
        expect(observed).toHaveLength(1);
        expect(observed[0]?.status).toBe('failed');
        expect(observed[0]?.error).toMatch(/timed out/);
        expect(reward).toBeCloseTo(-0.5, 3);
    });

    it('invokes onTaskResult for every task, in order', async () => {
        const observed: string[] = [];
        const evalFn = createLiveEvaluator({
            sendPrompt: makeSender([
                { text: 'a', costUsd: 0.01 },
                { text: 'b', costUsd: 0.01 },
            ]),
            model: 'test-model',
            onTaskResult: (task) => observed.push(task.id),
        });
        await evalFn('c', TASKS);
        expect(observed).toEqual(['t1', 't2']);
    });

    it('gives a higher reward to a cheaper candidate', async () => {
        // Cheap candidate averages $0.005/task; expensive averages $0.05/task.
        // Cheap reward ≈ 1 - 0.02 = 0.98; expensive ≈ 1 - 0.2 = 0.80.
        const cheapEval = createLiveEvaluator({
            sendPrompt: makeSender([
                { text: 'ok', costUsd: 0.005 },
                { text: 'ok', costUsd: 0.005 },
            ]),
            model: 'test-model',
        });
        const pricyEval = createLiveEvaluator({
            sendPrompt: makeSender([
                { text: 'ok', costUsd: 0.05 },
                { text: 'ok', costUsd: 0.05 },
            ]),
            model: 'test-model',
        });

        const cheapReward = await cheapEval('cheap', TASKS);
        const pricyReward = await pricyEval('pricy', TASKS);

        expect(cheapReward).toBeGreaterThan(pricyReward);
        expect(cheapReward).toBeCloseTo(0.98, 3);
        expect(pricyReward).toBeCloseTo(0.80, 3);
    });
});
