/**
 * KageOps Learning — APO Engine (Phase 4 iter 1)
 *
 * Agent-lightning-inspired beam search over prompt candidates. Each round:
 *   1. For each surviving beam candidate, generate `branchFactor` mutants
 *      via `mutatePrompt` (LLM-driven rewrite, injected).
 *   2. Score every mutant via `evalPrompt` (injected — in prod this runs
 *      the agent on held-out tasks; in tests a deterministic fake).
 *   3. Keep the top `beamWidth` candidates by reward for the next round.
 *
 * Design choices:
 *   - Beam=4, branch=3, rounds=5 (agent-lightning defaults). Search width
 *     = 12 candidates/round → 60 evaluations worst-case. Bounded cost.
 *   - `evalPrompt` is fully injected so we can defer the live-agent eval
 *     (B-471 real-world scoring) to a later iteration. Any function of
 *     shape `(prompt) => Promise<number>` is acceptable.
 *   - Baseline seed is evaluated once and always survives round 1 — it
 *     sits in the initial beam alongside `beamWidth - 1` empty slots
 *     that get populated by the first round of mutation.
 *   - Identical prompts are deduped by string equality before evaluation
 *     to avoid wasted LLM spend when the mutator returns a fixed point.
 *
 * Cost guard: this module does NOT call the LLM directly. Both injected
 * callbacks (`sendPrompt`, `evalPrompt`) are expected to respect per-task
 * budget caps. In prod, wire `ai-adapter.sendPrompt` for the mutator — it
 * already routes through cost tracking.
 */

import { mutatePrompt, type SendPromptFn } from './prompt-mutator';
import type { Candidate, OptimizationResult, Round } from './types';
import { createLogger } from '../shared/logger';

const log = createLogger('APO');

// ── Defaults ─────────────────────────────────────────

const DEFAULT_BEAM_WIDTH = 4;
const DEFAULT_BRANCH_FACTOR = 3;
const DEFAULT_ROUNDS = 5;

// ── Types ────────────────────────────────────────────

/**
 * Evaluate a prompt against held-out tasks, returning a scalar reward in
 * [-1, 1]. Tests pass a deterministic fake (e.g. `p => p.length`); prod
 * wires this to a real-agent runner over `sampleTasks`.
 */
export type EvalPromptFn = (
    prompt: string,
    sampleTasks: readonly SampleTask[]
) => Promise<number>;

/**
 * A held-out sample task used for reward scoring. Shape is intentionally
 * loose — callers populate it with whatever the evaluator needs.
 */
export interface SampleTask {
    readonly id: string;
    readonly description: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OptimizeOptions {
    readonly beamWidth?: number;
    readonly branchFactor?: number;
    readonly rounds?: number;
    readonly sendPrompt: SendPromptFn;
    readonly evalPrompt: EvalPromptFn;
    /**
     * One-sentence diagnostic that drives the mutator. If omitted, we fall
     * back to a generic "improve this agent prompt" critique.
     */
    readonly critique?: string;
}

// ── Engine ───────────────────────────────────────────

/**
 * Run beam-search prompt optimization for a single agent.
 *
 * Returns the full search history (including baseline) so callers can
 * persist or visualize the optimization trajectory.
 *
 * Note: the baseline is evaluated once, BEFORE any mutation, and scored
 * against `sampleTasks`. Every mutant is scored against the same held-out
 * set so reward deltas are comparable.
 */
export async function optimize(
    agentName: string,
    baselinePrompt: string,
    sampleTasks: readonly SampleTask[],
    opts: OptimizeOptions
): Promise<OptimizationResult> {
    const beamWidth = opts.beamWidth ?? DEFAULT_BEAM_WIDTH;
    const branchFactor = opts.branchFactor ?? DEFAULT_BRANCH_FACTOR;
    const rounds = opts.rounds ?? DEFAULT_ROUNDS;
    const critique =
        opts.critique ??
        `${agentName}'s responses could be shorter, cheaper, and more consistent.`;

    validateOpts(beamWidth, branchFactor, rounds);

    if (baselinePrompt.trim() === '') {
        throw new Error('[APO] optimize: baselinePrompt is empty.');
    }

    log.info(
        { agentName, beamWidth, branchFactor, rounds, nSamples: sampleTasks.length },
        'optimize: starting beam search'
    );

    // ── Round 0 — baseline ────────────────────────
    const baselineReward = await opts.evalPrompt(baselinePrompt, sampleTasks);
    const baselineCandidate: Candidate = Object.freeze({
        id: 'baseline',
        prompt: baselinePrompt,
        reward: baselineReward,
        parentId: null,
        round: 0,
    });

    const history: Round[] = [
        Object.freeze({
            round: 0,
            candidates: Object.freeze([baselineCandidate]),
            bestReward: baselineReward,
        }),
    ];

    // Beam always carries the best survivors across rounds. Seed with baseline.
    let beam: readonly Candidate[] = [baselineCandidate];

    // Track every prompt we have already scored so we never re-evaluate the
    // same string — keeps LLM spend bounded when the mutator hits a fixed
    // point. Seed with the baseline so round-1 mutants that collapse back to
    // the baseline are also skipped.
    const evaluatedPrompts = new Set<string>([baselinePrompt]);

    for (let round = 1; round <= rounds; round++) {
        const mutants: Candidate[] = [];

        for (const parent of beam) {
            for (let branch = 0; branch < branchFactor; branch++) {
                let mutated: string;
                try {
                    mutated = await mutatePrompt(parent.prompt, critique, opts.sendPrompt);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    log.warn(
                        { agentName, round, parentId: parent.id, branch, err: message },
                        'optimize: mutation failed — skipping this branch'
                    );
                    continue;
                }
                mutants.push(
                    Object.freeze({
                        id: `r${round}-p${parent.id}-b${branch}`,
                        prompt: mutated,
                        // reward filled in below
                        reward: Number.NEGATIVE_INFINITY,
                        parentId: parent.id,
                        round,
                    })
                );
            }
        }

        // Dedup mutants within this round AND against anything we have
        // already evaluated in a previous round.
        const uniqueMutants = dedupeByPrompt(mutants).filter(
            (m) => !evaluatedPrompts.has(m.prompt)
        );

        // Score every unique, not-yet-seen mutant.
        const scored: Candidate[] = [];
        for (const m of uniqueMutants) {
            const reward = await opts.evalPrompt(m.prompt, sampleTasks);
            evaluatedPrompts.add(m.prompt);
            scored.push(Object.freeze({ ...m, reward }));
        }

        // Candidate pool = previous beam ∪ new mutants (elitism: best prompts
        // never regress out of the beam purely because a round generated no
        // improvement).
        const pool = [...beam, ...scored];
        const deduped = dedupeByPrompt(pool);

        // Keep top-`beamWidth` by reward.
        const sorted = [...deduped].sort((a, b) => b.reward - a.reward);
        beam = Object.freeze(sorted.slice(0, beamWidth));

        const bestReward = beam[0]?.reward ?? baselineReward;
        history.push(
            Object.freeze({
                round,
                candidates: Object.freeze([...beam]),
                bestReward,
            })
        );

        log.info(
            { agentName, round, bestReward, beamSize: beam.length },
            'optimize: round complete'
        );
    }

    const winner = beam[0] ?? baselineCandidate;
    const winnerReward = winner.reward;

    return Object.freeze({
        agentName,
        baselinePrompt,
        baselineReward,
        winner: winner.prompt,
        winnerReward,
        delta: winnerReward - baselineReward,
        rounds,
        beamWidth,
        branchFactor,
        history: Object.freeze(history),
    });
}

// ── Helpers ──────────────────────────────────────────

function dedupeByPrompt(cands: readonly Candidate[]): Candidate[] {
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const c of cands) {
        if (seen.has(c.prompt)) continue;
        seen.add(c.prompt);
        out.push(c);
    }
    return out;
}

function validateOpts(beamWidth: number, branchFactor: number, rounds: number): void {
    if (!Number.isInteger(beamWidth) || beamWidth < 1) {
        throw new Error(`[APO] optimize: beamWidth must be a positive int (got ${beamWidth}).`);
    }
    if (!Number.isInteger(branchFactor) || branchFactor < 1) {
        throw new Error(`[APO] optimize: branchFactor must be a positive int (got ${branchFactor}).`);
    }
    if (!Number.isInteger(rounds) || rounds < 1) {
        throw new Error(`[APO] optimize: rounds must be a positive int (got ${rounds}).`);
    }
}
