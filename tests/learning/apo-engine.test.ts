/**
 * Tests for src/learning/apo-engine.ts
 *
 * We inject deterministic `sendPrompt` + `evalPrompt` fakes so beam search
 * is reproducible. No real LLM calls, no Postgres.
 *
 * Key invariants we assert:
 *  1. Round 0 contains exactly the baseline candidate.
 *  2. Per-round `bestReward` is monotonically non-decreasing (elitism).
 *  3. With an evaluator that rewards longer prompts and a mutator that
 *     appends characters, the winner has reward > baseline.
 *  4. `delta == winnerReward - baselineReward`.
 *  5. Beam is pruned to at most `beamWidth` per round.
 *  6. Validation rejects non-positive integers for width/branch/rounds.
 */

import { describe, it, expect, vi } from 'vitest';

import {
    optimize,
    type EvalPromptFn,
    type SampleTask,
} from '../../src/learning/apo-engine';
import type { SendPromptFn } from '../../src/learning/prompt-mutator';

// ── Fixtures ─────────────────────────────────────────

const SAMPLES: readonly SampleTask[] = Object.freeze([
    { id: 's1', description: 'sample 1' },
    { id: 's2', description: 'sample 2' },
]);

/** Evaluator: reward = prompt length / 100 (longer = better, deterministic). */
const evalByLength: EvalPromptFn = async (prompt) => prompt.length / 100;

/**
 * Mutator that uniquely extends its input by a counter — guarantees strict
 * monotonic length growth so beam search produces a clear winner.
 */
function makeLengthGrowingSender(): SendPromptFn {
    let counter = 0;
    return (async (_model, _sys, userPrompt: string) => {
        counter += 1;
        // Extract the baseline part that sits after the "---" divider in
        // mutator's user prompt, then append a unique suffix to force growth.
        const dividerIdx = userPrompt.indexOf('---');
        const baselinePart = dividerIdx >= 0 ? userPrompt.slice(dividerIdx + 3).trim() : userPrompt;
        return { text: `${baselinePart} [v${counter}]` };
    }) as SendPromptFn;
}

// ── Tests ────────────────────────────────────────────

describe('optimize()', () => {
    it('records baseline in round 0 before any mutation', async () => {
        const send = vi.fn(async () => ({ text: 'never-called' })) as unknown as SendPromptFn;
        const evalFn = vi.fn(async (p: string) => p.length) as EvalPromptFn;

        const result = await optimize('scout', 'BASELINE', SAMPLES, {
            beamWidth: 2,
            branchFactor: 1,
            rounds: 1,
            sendPrompt: send,
            evalPrompt: evalFn,
        });

        expect(result.history.length).toBe(2); // round 0 + round 1
        const round0 = result.history[0];
        expect(round0.round).toBe(0);
        expect(round0.candidates).toHaveLength(1);
        expect(round0.candidates[0].prompt).toBe('BASELINE');
        expect(round0.candidates[0].parentId).toBeNull();
    });

    it('per-round bestReward is monotonically non-decreasing (elitism)', async () => {
        const result = await optimize('herald', 'seed-prompt', SAMPLES, {
            beamWidth: 3,
            branchFactor: 2,
            rounds: 4,
            sendPrompt: makeLengthGrowingSender(),
            evalPrompt: evalByLength,
        });

        for (let i = 1; i < result.history.length; i++) {
            expect(result.history[i].bestReward).toBeGreaterThanOrEqual(
                result.history[i - 1].bestReward
            );
        }
    });

    it('winner beats baseline when the evaluator rewards growth', async () => {
        const result = await optimize('pixel', 'start', SAMPLES, {
            beamWidth: 2,
            branchFactor: 2,
            rounds: 3,
            sendPrompt: makeLengthGrowingSender(),
            evalPrompt: evalByLength,
        });

        expect(result.winnerReward).toBeGreaterThan(result.baselineReward);
        expect(result.delta).toBeCloseTo(result.winnerReward - result.baselineReward, 10);
        expect(result.winner).not.toBe(result.baselinePrompt);
    });

    it('prunes each round to at most beamWidth candidates', async () => {
        const result = await optimize('scout', 'p', SAMPLES, {
            beamWidth: 2,
            branchFactor: 3,
            rounds: 3,
            sendPrompt: makeLengthGrowingSender(),
            evalPrompt: evalByLength,
        });

        for (let i = 1; i < result.history.length; i++) {
            expect(result.history[i].candidates.length).toBeLessThanOrEqual(2);
        }
    });

    it('does not re-evaluate duplicate prompts within a round', async () => {
        // Mutator returns the same string every call — dedupe should trigger.
        const constSend: SendPromptFn = (async () => ({ text: 'CONST' })) as SendPromptFn;
        const evalFn = vi.fn(async (p: string) => p.length) as EvalPromptFn;

        await optimize('scout', 'BASELINE', SAMPLES, {
            beamWidth: 4,
            branchFactor: 3,
            rounds: 2,
            sendPrompt: constSend,
            evalPrompt: evalFn,
        });

        // Expected eval calls:
        //   round 0: 1 (baseline)
        //   round 1: 1 unique mutant "CONST" (3 mutants deduped to 1)
        //   round 2: 0 new unique mutants (still "CONST", already in pool)
        expect((evalFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(2);
    });

    it('survives a mutator that throws for some branches', async () => {
        let call = 0;
        const flaky: SendPromptFn = (async () => {
            call += 1;
            if (call % 2 === 0) throw new Error('transient');
            return { text: `ok-${call}` };
        }) as SendPromptFn;

        const result = await optimize('scout', 'baseline-x', SAMPLES, {
            beamWidth: 2,
            branchFactor: 2,
            rounds: 2,
            sendPrompt: flaky,
            evalPrompt: evalByLength,
        });

        // Even with half the mutations failing, the run must complete and
        // history must contain all rounds including the baseline.
        expect(result.history.length).toBe(3); // round 0 + 2 rounds
        expect(Number.isFinite(result.winnerReward)).toBe(true);
    });

    it('returns baselinePrompt as winner when no mutation improves on it', async () => {
        // Evaluator rewards the baseline exclusively.
        const targeted: EvalPromptFn = async (prompt) =>
            prompt === 'THE-BASELINE' ? 1 : 0;

        const result = await optimize('scout', 'THE-BASELINE', SAMPLES, {
            beamWidth: 2,
            branchFactor: 2,
            rounds: 2,
            sendPrompt: makeLengthGrowingSender(),
            evalPrompt: targeted,
        });

        expect(result.winner).toBe('THE-BASELINE');
        expect(result.delta).toBeCloseTo(0, 10);
    });

    it('rejects invalid beam/branch/rounds', async () => {
        const send = makeLengthGrowingSender();
        await expect(
            optimize('scout', 'p', SAMPLES, {
                beamWidth: 0,
                branchFactor: 2,
                rounds: 1,
                sendPrompt: send,
                evalPrompt: evalByLength,
            })
        ).rejects.toThrow(/beamWidth/);

        await expect(
            optimize('scout', 'p', SAMPLES, {
                beamWidth: 2,
                branchFactor: -1,
                rounds: 1,
                sendPrompt: send,
                evalPrompt: evalByLength,
            })
        ).rejects.toThrow(/branchFactor/);

        await expect(
            optimize('scout', 'p', SAMPLES, {
                beamWidth: 2,
                branchFactor: 2,
                rounds: 0,
                sendPrompt: send,
                evalPrompt: evalByLength,
            })
        ).rejects.toThrow(/rounds/);
    });

    it('rejects empty baseline prompt', async () => {
        await expect(
            optimize('scout', '   ', SAMPLES, {
                beamWidth: 2,
                branchFactor: 2,
                rounds: 2,
                sendPrompt: makeLengthGrowingSender(),
                evalPrompt: evalByLength,
            })
        ).rejects.toThrow(/baselinePrompt/);
    });

    it('result fields match documented invariants', async () => {
        const result = await optimize('herald', 'base', SAMPLES, {
            beamWidth: 3,
            branchFactor: 2,
            rounds: 2,
            sendPrompt: makeLengthGrowingSender(),
            evalPrompt: evalByLength,
        });

        expect(result.agentName).toBe('herald');
        expect(result.baselinePrompt).toBe('base');
        expect(result.rounds).toBe(2);
        expect(result.beamWidth).toBe(3);
        expect(result.branchFactor).toBe(2);
        expect(result.delta).toBeCloseTo(result.winnerReward - result.baselineReward, 10);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.history)).toBe(true);
    });
});
