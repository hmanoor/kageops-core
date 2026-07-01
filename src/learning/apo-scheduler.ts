/**
 * KageOps Learning — Nightly APO Scheduler (v0.11)
 *
 * Wires the already-tested pieces into a single scheduled loop:
 *
 *   for each APO-eligible agent:
 *     baseline ← loadBaselinePrompt(agent)       (preset override ?? built-in)
 *     tasks    ← loadGoldenTasks(agent)          (held-out corpus)
 *     eval     ← createLiveEvaluator({sendPrompt, model, ...})
 *     result   ← optimize(agent, baseline, tasks, {sendPrompt, evalPrompt})
 *     if result.delta >= minDelta:
 *        persistProposedOptimization(result, {nSamples: tasks.length})
 *
 * Design choices:
 *   - **No auto-apply.** Operators review the proposed row in the Command
 *     Center history panel and explicitly accept (future "Apply suggestion"
 *     button). Keeping the scheduler read-only on the filesystem side
 *     means a bad night never overwrites a live preset.
 *   - **Injectable deps.** Every side-effecting surface (baseline source,
 *     task source, LLM send, persister) is parameter-passed so tests run
 *     without Postgres, network, or fs. Production wiring in main.ts
 *     threads real implementations.
 *   - **Thresholded persistence.** A reward delta below `minDelta`
 *     (default `0.02`) is treated as noise and is not written. The schema
 *     has no CHECK constraint on delta, but cluttering the history with
 *     near-zero wins makes the UI useless.
 *   - **Per-agent isolation.** One agent crashing (missing tasks, eval
 *     exception) MUST NOT abort the rest of the run — each agent is
 *     wrapped in try/catch and the scheduler returns an aggregate report.
 *   - **Zero fire-and-forget loops.** `startApoScheduler` returns a
 *     `{stop}` handle so the caller can shut the loop down cleanly on
 *     app exit. The timer uses `unref()` so it never blocks process exit
 *     on its own.
 *
 * NOT in this module:
 *   - Talking to `applyWinner` / accepting rows — that's the upcoming
 *     "Apply suggestion" button.
 *   - Reading golden-tasks.json — that module is on PR #17. The caller
 *     passes in a `loadGoldenTasks` function so this file stays decoupled.
 */

import { createLogger } from '../shared/logger';
import { optimize, type EvalPromptFn, type SampleTask } from './apo-engine';
import { createLiveEvaluator } from './live-eval';
import type { SendPromptFn } from './prompt-mutator';
import { persistProposedOptimization } from './optimization-record';
import type { OptimizationResult, PromptOptimizationRecord } from './types';
import { APO_ELIGIBLE_AGENTS } from './types';

const log = createLogger('APO.Scheduler');

// ── Defaults ─────────────────────────────────────────

/** Delta below this is treated as noise and NOT persisted. */
const DEFAULT_MIN_DELTA = 0.02;

/** One run per day by default. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Wait 5 min after boot before the first nightly run — let the app settle. */
const DEFAULT_INITIAL_DELAY_MS = 5 * 60 * 1000;

// ── Dependency surfaces ──────────────────────────────

/**
 * Resolves the prompt APO should start optimizing from for a given agent.
 * Returning `null` tells the scheduler to skip the agent (missing baseline
 * is a config problem, not a search problem).
 */
export type LoadBaselinePromptFn = (agentName: string) => string | null;

/**
 * Returns the held-out task set for an agent. An empty array skips APO
 * for that agent (no evaluation signal).
 */
export type LoadGoldenTasksFn = (agentName: string) => readonly SampleTask[];

/** Persists a single optimization result. Swappable for tests. */
export type PersistOptimizationFn = (
    result: OptimizationResult,
    opts: { readonly nSamples: number }
) => Promise<PromptOptimizationRecord>;

/** Factory for `EvalPromptFn`. Swappable for tests. */
export type EvaluatorFactoryFn = (
    agentName: string
) => EvalPromptFn;

// ── Options ──────────────────────────────────────────

export interface ApoSchedulerDeps {
    readonly loadBaselinePrompt: LoadBaselinePromptFn;
    readonly loadGoldenTasks: LoadGoldenTasksFn;
    readonly sendPrompt: SendPromptFn;
    readonly model: string;
    /** Defaults to `persistProposedOptimization`. */
    readonly persistOptimization?: PersistOptimizationFn;
    /** Defaults to `createLiveEvaluator({sendPrompt, model, budgetCapUsd})`. */
    readonly evaluatorFactory?: EvaluatorFactoryFn;
}

export interface RunApoOptions {
    /** Beam search width. Default: engine default (4). */
    readonly beamWidth?: number;
    /** Branch factor per parent. Default: engine default (3). */
    readonly branchFactor?: number;
    /** Number of rounds. Default: engine default (5). */
    readonly rounds?: number;
    /** Minimum reward delta to persist. Default 0.02. */
    readonly minDelta?: number;
    /** Per-candidate spend cap in USD. Default 0.10 (live-eval default). */
    readonly budgetCapUsd?: number;
    /**
     * Override the eligible agent list (useful for tests that want to run
     * against a single fixture agent). Defaults to `APO_ELIGIBLE_AGENTS`.
     */
    readonly agents?: readonly string[];
}

export interface SchedulerOptions extends RunApoOptions {
    /** Time between runs. Default 24h. */
    readonly intervalMs?: number;
    /** Delay before first run. Default 5min. */
    readonly initialDelayMs?: number;
    /**
     * If true, fire the first run immediately (ignoring `initialDelayMs`).
     * Useful for dev / CLI.
     */
    readonly runImmediately?: boolean;
    /**
     * Called after every completed run (success or individual-agent errors),
     * with the aggregate report. Useful for refreshing the Command Center
     * history panel or for test synchronization.
     */
    readonly onRunComplete?: (report: ApoRunReport) => void;
}

// ── Result shapes ────────────────────────────────────

export interface PerAgentOutcome {
    readonly agentName: string;
    readonly status: 'persisted' | 'below-threshold' | 'skipped' | 'error';
    readonly delta: number | null;
    readonly optimizationId: string | null;
    readonly nSamples: number;
    readonly error: string | null;
}

export interface ApoRunReport {
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly outcomes: readonly PerAgentOutcome[];
}

export interface SchedulerHandle {
    /** Stop the loop and clear the pending timer. Safe to call twice. */
    stop(): void;
    /**
     * Resolves with the most-recent run report, or `null` if no run has
     * completed yet. Exposed for tests and debug overlays.
     */
    lastReport(): ApoRunReport | null;
}

// ── Public API — single agent ────────────────────────

export async function runApoForAgent(
    agentName: string,
    deps: ApoSchedulerDeps,
    opts: RunApoOptions = {}
): Promise<PerAgentOutcome> {
    if (!APO_ELIGIBLE_AGENTS.includes(agentName)) {
        return freezeOutcome({
            agentName,
            status: 'skipped',
            delta: null,
            optimizationId: null,
            nSamples: 0,
            error: 'agent not APO-eligible',
        });
    }

    const minDelta = opts.minDelta ?? DEFAULT_MIN_DELTA;

    try {
        const baseline = deps.loadBaselinePrompt(agentName);
        if (baseline === null || baseline.trim() === '') {
            log.warn({ agentName }, 'runApoForAgent: baseline prompt missing — skipping');
            return freezeOutcome({
                agentName,
                status: 'skipped',
                delta: null,
                optimizationId: null,
                nSamples: 0,
                error: 'missing baseline prompt',
            });
        }

        const tasks = deps.loadGoldenTasks(agentName);
        if (tasks.length === 0) {
            log.warn({ agentName }, 'runApoForAgent: no golden tasks — skipping');
            return freezeOutcome({
                agentName,
                status: 'skipped',
                delta: null,
                optimizationId: null,
                nSamples: 0,
                error: 'no golden tasks',
            });
        }

        const evalPrompt = (deps.evaluatorFactory ?? defaultEvaluatorFactory(deps, opts))(agentName);

        const result = await optimize(agentName, baseline, tasks, {
            sendPrompt: deps.sendPrompt,
            evalPrompt,
            beamWidth: opts.beamWidth,
            branchFactor: opts.branchFactor,
            rounds: opts.rounds,
        });

        if (result.delta < minDelta) {
            log.info(
                { agentName, delta: result.delta, minDelta },
                'runApoForAgent: delta below threshold — not persisting'
            );
            return freezeOutcome({
                agentName,
                status: 'below-threshold',
                delta: result.delta,
                optimizationId: null,
                nSamples: tasks.length,
                error: null,
            });
        }

        const persist = deps.persistOptimization ?? persistProposedOptimization;
        const record = await persist(result, { nSamples: tasks.length });

        log.info(
            { agentName, id: record.id, delta: result.delta },
            'runApoForAgent: persisted proposed row'
        );
        return freezeOutcome({
            agentName,
            status: 'persisted',
            delta: result.delta,
            optimizationId: record.id,
            nSamples: tasks.length,
            error: null,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ agentName, err: message }, 'runApoForAgent: aborted with error');
        return freezeOutcome({
            agentName,
            status: 'error',
            delta: null,
            optimizationId: null,
            nSamples: 0,
            error: message,
        });
    }
}

// ── Public API — all eligible ────────────────────────

export async function runApoForAllEligible(
    deps: ApoSchedulerDeps,
    opts: RunApoOptions = {}
): Promise<ApoRunReport> {
    const agents = opts.agents ?? APO_ELIGIBLE_AGENTS;
    const startedAt = new Date().toISOString();
    const outcomes: PerAgentOutcome[] = [];
    for (const agentName of agents) {
        const outcome = await runApoForAgent(agentName, deps, opts);
        outcomes.push(outcome);
    }
    const finishedAt = new Date().toISOString();
    const report = Object.freeze({
        startedAt,
        finishedAt,
        outcomes: Object.freeze(outcomes),
    });
    log.info(
        {
            startedAt,
            finishedAt,
            persisted: outcomes.filter((o) => o.status === 'persisted').length,
            errors: outcomes.filter((o) => o.status === 'error').length,
            belowThreshold: outcomes.filter((o) => o.status === 'below-threshold').length,
            skipped: outcomes.filter((o) => o.status === 'skipped').length,
        },
        'runApoForAllEligible: complete'
    );
    return report;
}

// ── Public API — scheduler wrapper ───────────────────

/**
 * Start a repeating APO run. Returns a handle with `stop()` and
 * `lastReport()`. Intended to be called once at app boot.
 *
 * The timer is `unref`ed so it never blocks process exit; callers that
 * care about graceful shutdown must still call `stop()` to prevent the
 * in-flight run from racing with shutdown-time resource teardown.
 */
export function startApoScheduler(
    deps: ApoSchedulerDeps,
    opts: SchedulerOptions = {}
): SchedulerHandle {
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const initialDelayMs = opts.runImmediately === true
        ? 0
        : opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastReport: ApoRunReport | null = null;

    async function tick(): Promise<void> {
        if (stopped) return;
        try {
            lastReport = await runApoForAllEligible(deps, opts);
            if (lastReport !== null) {
                opts.onRunComplete?.(lastReport);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error({ err: message }, 'startApoScheduler: tick crashed — scheduling next anyway');
        }
        if (stopped) return;
        timer = setTimeout(() => void tick(), intervalMs);
        timer.unref?.();
    }

    timer = setTimeout(() => void tick(), initialDelayMs);
    timer.unref?.();

    return Object.freeze({
        stop(): void {
            stopped = true;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
        },
        lastReport(): ApoRunReport | null {
            return lastReport;
        },
    });
}

// ── Internals ────────────────────────────────────────

function defaultEvaluatorFactory(
    deps: ApoSchedulerDeps,
    opts: RunApoOptions
): EvaluatorFactoryFn {
    return () => createLiveEvaluator({
        sendPrompt: deps.sendPrompt,
        model: deps.model,
        budgetCapUsd: opts.budgetCapUsd,
    });
}

function freezeOutcome(o: PerAgentOutcome): PerAgentOutcome {
    return Object.freeze(o);
}
